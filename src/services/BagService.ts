import { Bag } from '@foxglove/rosbag';
import { ImageProcessor } from './ImageProcessor';

// --- Interfaces ---
interface Time {
    sec: number;
    nsec: number;
}

export interface JointStateMsg {
    header?: any;
    name: string[];
    position: number[];
    velocity: number[];
    effort: number[];
}

export type ParsedFrame = {
    timestamp: number;
    index: number;
    images: Record<string, string>;
    jointStateMap: Record<string, JointStateMsg>;
};

type FrameImageMap = Map<string, Time>;

// --- Browser File Adapter ---
class BrowserFile {
    file: File;
    constructor(file: File) { this.file = file; }
    async read(offset: number, length: number): Promise<Uint8Array> {
        const slice = this.file.slice(offset, offset + length);
        const arrayBuffer = await slice.arrayBuffer();
        return new Uint8Array(arrayBuffer);
    }
    size(): number { return this.file.size; }
}

interface LightMessage {
    timestamp: number; // ms
    originalTime: Time;
    topic: string;
    data?: any;
}

export class BagService {
    private bag: Bag | null = null;
    private imageProcessor = new ImageProcessor();

    // --- Public State ---
    public timestamps: number[] = []; 
    public topicMetadata: Record<string, { msgType: string; title: string }> = {};
    public historicalJointData: Map<number, Record<string, JointStateMsg>> = new Map();

    // --- Private State ---
    private imageTopics: string[] = [];
    private jointTopics: string[] = [];
    private frameImageIndex = new Map<number, FrameImageMap>(); // FrameIndex -> { Topic -> ExactTimestamp }
    private frameCache = new Map<number, ParsedFrame>();

    async loadFile(file: File, onProgress?: (msg: string) => void): Promise<void> {
        onProgress?.('Initializing OpenCV...');
        await this.imageProcessor.init();
        this.reset();

        try {
            onProgress?.('Opening Bag File...');
            const bagReader = new BrowserFile(file);
            this.bag = new Bag(bagReader);
            await this.bag.open();

            // 1. Analyze Topics
            onProgress?.('Analyzing Topics...');
            for (const conn of this.bag.connections.values()) {
                if (conn.type === 'sensor_msgs/Image' || conn.type === 'sensor_msgs/CompressedImage') {
                    this.topicMetadata[conn.topic] = { msgType: conn.type, title: conn.topic };
                    this.imageTopics.push(conn.topic);
                }
                if (conn.type === 'sensor_msgs/JointState') {
                    this.topicMetadata[conn.topic] = { msgType: conn.type, title: conn.topic };
                    this.jointTopics.push(conn.topic);
                }
                console.log(conn);
            }
            
            // Sort topics for consistent processing
            this.imageTopics.sort();
            this.jointTopics.sort();

            const targetTopics = [...this.imageTopics, ...this.jointTopics];
            if (targetTopics.length === 0) throw new Error("No compatible topics found.");

            // 2. Extract All Messages
            onProgress?.('Scanning Messages...');
            
            const allMessages: LightMessage[] = [];
            
            // Read messages for target topics
            for await (const msg of this.bag.messageIterator({ topics: targetTopics })) {
                const ts = this.timeToMs(msg.timestamp);
                const lightMsg: LightMessage = {
                    timestamp: ts,
                    originalTime: msg.timestamp,
                    topic: msg.topic
                };

                // For JointState, we need the full data
                if (this.jointTopics.includes(msg.topic)) {
                    lightMsg.data = msg.message;
                }
                // Otherwise, for Image, we only need the timestamp
                allMessages.push(lightMsg);
            }

            if (allMessages.length === 0) throw new Error("No messages found.");

            // Sort messages by timestamp
            allMessages.sort((a, b) => a.timestamp - b.timestamp);

            // 3. Bootstrapping
            onProgress?.('Aligning Timeline...');
            
            const seenTopics = new Set<string>();
            let startMsgIndex = 0;
            let firstFullStateTime: number | null = null;
            
            const currentJoints: Record<string, any> = {}; 
            const currentImageTimes = new Map<string, Time>();

            for (let i = 0; i < allMessages.length; i++) {
                const msg = allMessages[i];
                seenTopics.add(msg.topic);

                // Update current state
                if (this.jointTopics.includes(msg.topic)) {
                    currentJoints[msg.topic] = msg.data;
                } else {
                    currentImageTimes.set(msg.topic, msg.originalTime);
                }

                // Check if all topics have been seen
                const allReady = targetTopics.every(t => seenTopics.has(t));
                if (allReady) {
                    firstFullStateTime = msg.timestamp;
                    startMsgIndex = i; // Start from the next message
                    break;
                }
            }

            if (firstFullStateTime === null) {
                console.warn("Incomplete bag: not all topics appeared. Falling back to simple start.");
                firstFullStateTime = allMessages[0].timestamp;
                startMsgIndex = 0;
            }

            // 4. Generate 30Hz Frames (ZOH Interpolation)
            onProgress?.('Interpolating Frames...');
            
            const endTime = allMessages[allMessages.length - 1].timestamp;
            let msgCursor = startMsgIndex;
            
            for (let t = firstFullStateTime; t <= endTime; t += 33.33) {
                const frameTime = Math.round(t);
                const frameIdx = this.timestamps.length;
                this.timestamps.push(frameTime);

                // Process messages up to current frame time
                while (msgCursor < allMessages.length && allMessages[msgCursor].timestamp <= t) {
                    const msg = allMessages[msgCursor];
                    
                    // Update current state
                    if (this.jointTopics.includes(msg.topic)) {
                        currentJoints[msg.topic] = msg.data;
                    } else {
                        currentImageTimes.set(msg.topic, msg.originalTime);
                    }
                    
                    msgCursor++;
                }
                // Snapshot data for this frame
                this.snapshotJointData(frameIdx, currentJoints);
                this.frameImageIndex.set(frameIdx, new Map(currentImageTimes));
            }

            onProgress?.('');
            console.log(`Loaded ${this.timestamps.length} frames. Start time: ${firstFullStateTime}`);

        } catch (err) {
            console.error("Error in loadFile:", err);
            throw err;
        }
    }

    private snapshotJointData(frameIdx: number, currentJoints: Record<string, any>) {
        const frameJoints: Record<string, JointStateMsg> = {};

        // Iterate over all discovered joint topics
        this.jointTopics.forEach(topic => {
            const rawMsg = currentJoints[topic];
            
            if (rawMsg) {
                if (!rawMsg.name || rawMsg.name.length === 0) {
                    const len = rawMsg.position ? rawMsg.position.length : 0;
                    const generatedNames = Array.from({ length: len }, (_, k) => `joint${k + 1}`);
                    frameJoints[topic] = {
                        ...rawMsg,
                        name: generatedNames
                    };
                } else {
                    frameJoints[topic] = rawMsg;
                }
            }
        });

        this.historicalJointData.set(frameIdx, frameJoints);
    }

    private reset() {
        this.frameCache.clear();
        this.timestamps = [];
        this.topicMetadata = {};
        this.historicalJointData.clear();
        this.frameImageIndex.clear();
        this.imageTopics = [];
        this.jointTopics = [];
        this.bag = null;
    }

    private timeToMs(t: Time): number {
        return t.sec * 1000 + Math.round(t.nsec / 1e6);
    }

    async getFrameAt(index: number): Promise<ParsedFrame | null> {
        if (!this.bag || index < 0 || index >= this.timestamps.length) return null;

        const targetTs = this.timestamps[index];
        if (this.frameCache.has(targetTs)) return this.frameCache.get(targetTs)!;

        const frameData: ParsedFrame = {
            timestamp: targetTs,
            index,
            images: {},
            jointStateMap: this.historicalJointData.get(index) || {}
        };

        const imageSnapshot = this.frameImageIndex.get(index);
        
        if (imageSnapshot && imageSnapshot.size > 0) {
            const promises = Array.from(imageSnapshot.entries()).map(async ([topic, exactTime]) => {
                try {
                     const iter = this.bag!.messageIterator({
                        topics: [topic],
                        start: exactTime,
                    });

                    for await (const msg of iter) {
                        const msgTime = msg.timestamp;
                        if (msgTime.sec === exactTime.sec && msgTime.nsec === exactTime.nsec) {
                             const msgAny = msg.message as any;
                             const type = this.topicMetadata[topic].msgType;
                             if (type.includes('CompressedImage')) {
                                const format = msgAny.format?.includes('png') ? 'png' : 'jpeg';
                                const blob = new Blob([msgAny.data], { type: `image/${format}` });
                                frameData.images[topic] = URL.createObjectURL(blob);
                             } else {
                                const url = this.imageProcessor.processMessage(msgAny);
                                if (url) frameData.images[topic] = url;
                             }
                        }
                        break; // Only need the first matching message
                    }
                } catch (e) { console.warn(e); }
            });
            await Promise.all(promises);
        }

        this.frameCache.set(targetTs, frameData);
        if (this.frameCache.size > 30) {
            const firstKey = this.frameCache.keys().next().value;
            if (firstKey !== undefined) this.frameCache.delete(firstKey);
        }

        return frameData;
    }
}