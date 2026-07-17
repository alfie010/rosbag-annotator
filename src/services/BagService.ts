import { Bag } from '@foxglove/rosbag';
import { ImageProcessor } from './ImageProcessor';

// --- Interfaces ---
interface Time {
    sec: number;
    nsec: number;
}

interface StringMsg {
    data: string;
}

interface OverlayAnnotation {
    kind: 'bbox' | 'point';
    x: number;
    y: number;
    width?: number;
    height?: number;
    radius?: number;
    label?: string;
    confidence?: number;
    color: string;
}

export interface JointStateMsg {
    header?: any;
    name: string[];
    position: number[];
    velocity: number[];
    effort: number[];
}

export interface WrenchStampedMsg {
    header?: any;
    wrench: {
        force: { x: number; y: number; z: number };
        torque: { x: number; y: number; z: number };
    };
}

export interface ChartSeriesMsg {
    name: string[];
    position?: number[];
    velocity?: number[];
    effort?: number[];
    force?: number[];
    torque?: number[];
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

const OVERLAY_DEBUG = false;
const overlayLog = (...args: any[]) => {
    if (OVERLAY_DEBUG) {
        console.log('[overlay-debug]', ...args);
    }
};

export class BagService {
    private bag: Bag | null = null;
    private imageProcessor = new ImageProcessor();

    // --- Public State ---
    public timestamps: number[] = []; 
    public topicMetadata: Record<string, { msgType: string; title: string }> = {};
    public historicalJointData: Map<number, Record<string, JointStateMsg>> = new Map();
    public historicalPlotData: Map<number, Record<string, ChartSeriesMsg>> = new Map();
    public historicalTaskState: Map<number, string> = new Map();

    // --- Private State ---
    private imageTopics: string[] = [];
    private jointTopics: string[] = [];
    private wrenchTopics: string[] = [];
    private stringTopics: string[] = [];
    private overlayTopics: string[] = [];
    private frameImageIndex = new Map<number, FrameImageMap>(); // FrameIndex -> { Topic -> ExactTimestamp }
    private frameOverlayIndex = new Map<number, Record<string, any>>();
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
                    this.topicMetadata[conn.topic] = { msgType: conn.type ?? 'unknown', title: conn.topic ?? '' };
                    this.imageTopics.push(conn.topic);
                }
                if (conn.type === 'sensor_msgs/JointState') {
                    this.topicMetadata[conn.topic] = { msgType: conn.type ?? 'unknown', title: conn.topic ?? '' };
                    this.jointTopics.push(conn.topic);
                }
                if (conn.type === 'geometry_msgs/WrenchStamped' || conn.type === 'geometry_msgs/msg/WrenchStamped') {
                    this.topicMetadata[conn.topic] = { msgType: conn.type ?? 'unknown', title: conn.topic ?? '' };
                    this.wrenchTopics.push(conn.topic);
                }
                if (conn.type === 'std_msgs/String') {
                    this.topicMetadata[conn.topic] = { msgType: conn.type ?? 'unknown', title: conn.topic ?? '' };
                    this.stringTopics.push(conn.topic);
                }
                const topicLeaf = conn.topic.split('/').filter(Boolean).pop() || conn.topic;
                if ((/^(bbox|points?|point)/i.test(topicLeaf) || /\/(bbox|points?|point)/i.test(conn.topic)) && !this.imageTopics.includes(conn.topic) && !this.jointTopics.includes(conn.topic) && !this.stringTopics.includes(conn.topic)) {
                    this.topicMetadata[conn.topic] = { msgType: conn.type ?? 'unknown', title: conn.topic ?? '' };
                    this.overlayTopics.push(conn.topic);
                    overlayLog('registered overlay topic', { topic: conn.topic, type: conn.type });
                }
                console.log(conn);
            }
            
            // Sort topics for consistent processing
            this.imageTopics.sort();
            this.jointTopics.sort();
            this.wrenchTopics.sort();
            this.overlayTopics.sort();

            const targetTopics = [...this.imageTopics, ...this.jointTopics, ...this.wrenchTopics, ...this.stringTopics, ...this.overlayTopics];
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
                if (this.jointTopics.includes(msg.topic) || this.wrenchTopics.includes(msg.topic) || this.stringTopics.includes(msg.topic) || this.overlayTopics.includes(msg.topic)) {
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
            const currentWrenches: Record<string, any> = {};
            const currentImageTimes = new Map<string, Time>();
            const currentOverlays: Record<string, any> = {};

            let currentTaskState = '';

            for (let i = 0; i < allMessages.length; i++) {
                const msg = allMessages[i];
                seenTopics.add(msg.topic);

                // Update current state
                if (this.jointTopics.includes(msg.topic)) {
                    currentJoints[msg.topic] = msg.data;
                } else if (this.wrenchTopics.includes(msg.topic)) {
                    currentWrenches[msg.topic] = msg.data;
                } else if (this.stringTopics.includes(msg.topic)) {
                    // Update task state if topic matches
                    if (msg.topic === '/puppet/task_state') {
                        currentTaskState = (msg.data as StringMsg).data;
                    }
                } else if (this.overlayTopics.includes(msg.topic)) {
                    currentOverlays[msg.topic] = msg.data;
                } else {
                    currentImageTimes.set(msg.topic, msg.originalTime);
                }

                // Check if all topics have been seen
                // Note: We don't strictly require task_state to be present to start the timeline
                // so we only check image/joint readiness for 'allReady'
                const vitalTopics = [...this.imageTopics, ...this.jointTopics, ...this.wrenchTopics];
                const allReady = vitalTopics.every(t => seenTopics.has(t));
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
                    } else if (this.wrenchTopics.includes(msg.topic)) {
                        currentWrenches[msg.topic] = msg.data;
                    } else if (this.stringTopics.includes(msg.topic)) {
                        // Update current state
                        if (msg.topic === '/puppet/task_state') {
                            currentTaskState = (msg.data as StringMsg).data;
                        }
                    } else if (this.overlayTopics.includes(msg.topic)) {
                        currentOverlays[msg.topic] = msg.data;
                    } else {
                        currentImageTimes.set(msg.topic, msg.originalTime);
                    }
                    
                    msgCursor++;
                }
                // Snapshot data for this frame
                this.snapshotJointData(frameIdx, currentJoints);
                this.snapshotPlotData(frameIdx, currentJoints, currentWrenches);
                this.snapshotOverlayData(frameIdx, currentOverlays);
                this.frameImageIndex.set(frameIdx, new Map(currentImageTimes));
                this.historicalTaskState.set(frameIdx, currentTaskState);
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

    private snapshotPlotData(frameIdx: number, currentJoints: Record<string, any>, currentWrenches: Record<string, any>) {
        const frameSeries: Record<string, ChartSeriesMsg> = {};

        this.jointTopics.forEach(topic => {
            const rawMsg = currentJoints[topic];
            if (!rawMsg) return;

            if (!rawMsg.name || rawMsg.name.length === 0) {
                const len = rawMsg.position ? rawMsg.position.length : 0;
                const generatedNames = Array.from({ length: len }, (_, k) => `joint${k + 1}`);
                frameSeries[topic] = {
                    ...rawMsg,
                    name: generatedNames
                };
            } else {
                frameSeries[topic] = rawMsg;
            }
        });

        this.wrenchTopics.forEach(topic => {
            const rawMsg = currentWrenches[topic] as WrenchStampedMsg | undefined;
            if (!rawMsg?.wrench) return;

            frameSeries[topic] = {
                name: ['force.x', 'force.y', 'force.z', 'torque.x', 'torque.y', 'torque.z'],
                force: [
                    rawMsg.wrench.force?.x ?? 0,
                    rawMsg.wrench.force?.y ?? 0,
                    rawMsg.wrench.force?.z ?? 0
                ],
                torque: [
                    rawMsg.wrench.torque?.x ?? 0,
                    rawMsg.wrench.torque?.y ?? 0,
                    rawMsg.wrench.torque?.z ?? 0
                ]
            };
        });

        this.historicalPlotData.set(frameIdx, frameSeries);
    }

    private snapshotOverlayData(frameIdx: number, currentOverlays: Record<string, any>) {
        this.frameOverlayIndex.set(frameIdx, { ...currentOverlays });
    }

    private reset() {
        this.frameCache.clear();
        this.timestamps = [];
        this.topicMetadata = {};
        this.historicalJointData.clear();
        this.historicalPlotData.clear();
        this.historicalTaskState.clear();
        this.frameImageIndex.clear();
        this.frameOverlayIndex.clear();
        this.imageTopics = [];
        this.jointTopics = [];
        this.wrenchTopics = [];
        this.stringTopics = [];
        this.overlayTopics = [];
        this.bag = null;
    }

    private timeToMs(t: Time): number {
        return t.sec * 1000 + Math.round(t.nsec / 1e6);
    }

    private async loadImage(src: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
            img.src = src;
        });
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
        const overlaySnapshot = this.frameOverlayIndex.get(index) || {};
        if (Object.keys(overlaySnapshot).length > 0) {
            overlayLog('frame overlay snapshot', { frame: index, topics: Object.keys(overlaySnapshot) });
        }
        
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
                                          frameData.images[topic] = await this.composeImageWithOverlays(topic, URL.createObjectURL(blob), overlaySnapshot);
                             } else {
                                const url = this.imageProcessor.processMessage(msgAny);
                                          if (url) frameData.images[topic] = await this.composeImageWithOverlays(topic, url, overlaySnapshot);
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

    private async composeImageWithOverlays(topic: string, src: string, overlaySnapshot: Record<string, any>): Promise<string> {
        try {
            const image = await this.loadImage(src);
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth || image.width || 640;
            canvas.height = image.naturalHeight || image.height || 480;

            const ctx = canvas.getContext('2d');
            if (!ctx) return src;

            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

            const overlays = this.collectOverlaysForImage(topic, overlaySnapshot);
            this.drawOverlays(ctx, overlays, canvas.width, canvas.height);

            return canvas.toDataURL('image/jpeg', 0.92);
        } catch (err) {
            console.warn(`Failed to composite overlays for ${topic}:`, err);
            return src;
        } finally {
            if (src.startsWith('blob:')) {
                URL.revokeObjectURL(src);
            }
        }
    }

    private collectOverlaysForImage(imageTopic: string, overlaySnapshot: Record<string, any>): OverlayAnnotation[] {
        const overlays: OverlayAnnotation[] = [];
        const imageToken = this.normalizeOverlayTopicToken(imageTopic);
        const hasZeroConfidenceBbox = Object.entries(overlaySnapshot).some(([overlayTopic, rawMsg]) => {
            if (!this.isOverlayRelevantToImage(overlayTopic, imageTopic)) return false;
            if (!/bbox/i.test(overlayTopic)) return false;
            const numericData = this.extractOverlayConfidence(rawMsg);
            return numericData === 0;
        });

        if (hasZeroConfidenceBbox) {
            overlayLog('skip overlays for zero-confidence bbox', { imageTopic, imageToken });
            return [];
        }

        for (const [overlayTopic, rawMsg] of Object.entries(overlaySnapshot)) {
            if (this.isOverlayRelevantToImage(overlayTopic, imageTopic)) {
                const parsed = this.parseOverlayMessage(overlayTopic, rawMsg);
                overlayLog('matched overlay topic', {
                    imageTopic,
                    overlayTopic,
                    parsedCount: parsed.length,
                    sample: this.summarizeOverlayPayload(rawMsg)
                });
                overlays.push(...parsed);
            }
        }

        return overlays;
    }

    private isOverlayRelevantToImage(overlayTopic: string, imageTopic: string): boolean {
        const overlayToken = this.normalizeOverlayTopicToken(overlayTopic);
        const imageToken = this.normalizeOverlayTopicToken(imageTopic);

        if (overlayToken && imageToken && overlayToken === imageToken) return true;

        const overlayParts = overlayTopic.replace(/^\/+/, '').split('/').filter(Boolean).filter(part => !/^(bbox|point)[_\-]?/i.test(part));
        const imageParts = imageTopic.replace(/^\/+/, '').split('/').filter(Boolean);

        if (overlayParts.length === 0 || imageParts.length === 0) return false;

        const maxPrefix = Math.min(overlayParts.length, imageParts.length);
        let prefixMatches = 0;
        for (let i = 0; i < maxPrefix; i++) {
            if (overlayParts[i] !== imageParts[i]) break;
            prefixMatches++;
        }

        return prefixMatches >= Math.min(2, overlayParts.length, imageParts.length)
            || overlayParts[overlayParts.length - 1] === imageParts[imageParts.length - 1]
            || Boolean(overlayToken && imageToken && imageToken.includes(overlayToken))
            || Boolean(overlayToken && imageToken && overlayToken.includes(imageToken));
    }

    private parseOverlayMessage(topic: string, rawMsg: any): OverlayAnnotation[] {
        const payload = this.unwrapOverlayPayload(rawMsg);

        overlayLog('parseOverlayMessage', {
            topic,
            payloadType: Array.isArray(payload) ? 'array' : typeof payload,
            summary: this.summarizeOverlayPayload(payload)
        });

        if (payload == null) return [];

        if (Array.isArray(payload)) {
            if (payload.length > 0 && typeof payload[0] === 'number') {
                return this.parseFloatArrayOverlay(topic, payload);
            }
            return payload.flatMap(item => this.parseOverlayMessage(topic, item));
        }

        if (typeof payload === 'string') {
            try {
                return this.parseOverlayMessage(topic, JSON.parse(payload));
            } catch {
                return [];
            }
        }

        if (typeof payload !== 'object') return [];

        const record = payload as Record<string, any>;
        const numericObjectData = this.readNumericSequenceFromObject(record);
        if (numericObjectData.length > 0) {
            overlayLog('inspect numeric-key overlay object', { topic, dataLength: numericObjectData.length, dataPreview: numericObjectData.slice(0, 8) });
            return this.parseFloatArrayOverlay(topic, numericObjectData);
        }

        if (record.poses && Array.isArray(record.poses)) {
            overlayLog('inspect PoseArray', { topic, poseCount: record.poses.length });
            return record.poses.flatMap((pose: any, index: number) => this.parsePoseArrayItem(topic, pose, index));
        }

        const numericData = this.readNumericSequence(record.data);
        if (numericData.length > 0) {
            overlayLog('inspect Float32MultiArray', { topic, dataLength: numericData.length, dataPreview: numericData.slice(0, 8) });
            return this.parseFloatArrayOverlay(topic, numericData);
        }

        if (ArrayBuffer.isView(record.data)) {
            const data = this.readNumericSequence(record.data);
            overlayLog('inspect Float32MultiArray', { topic, dataLength: data.length, dataPreview: data.slice(0, 8) });
            return this.parseFloatArrayOverlay(topic, data);
        }
        for (const key of ['boxes', 'detections', 'objects', 'results']) {
            if (Array.isArray(record[key])) {
                return record[key].flatMap((item: any) => this.parseOverlayMessage(topic, item));
            }
        }

        for (const key of ['points', 'keypoints']) {
            if (Array.isArray(record[key])) {
                return record[key].flatMap((item: any) => this.parseOverlayMessage(topic, item));
            }
        }

        for (const key of ['bbox', 'box', 'rect', 'point', 'center']) {
            if (record[key] && typeof record[key] === 'object') {
                return this.parseOverlayMessage(topic, record[key]);
            }
        }

        if (this.isPointLike(topic, record)) {
            const point = this.extractPoint(record);
            if (!point || this.shouldSkipConfidence(point.confidence)) return [];
            return [{ kind: 'point', ...point, color: this.getTopicColor(topic) }];
        }

        if (this.isBoxLike(topic, record)) {
            const box = this.extractBbox(record);
            if (!box || this.shouldSkipConfidence(box.confidence)) return [];
            return [{ kind: 'bbox', ...box, color: this.getTopicColor(topic) }];
        }

        return [];
    }

    private parsePoseArrayItem(topic: string, pose: any, index: number): OverlayAnnotation[] {
        const position = pose?.position;
        const x = this.readNumber(position?.x);
        const y = this.readNumber(position?.y);
        if (x === null || y === null) return [];

        const label = `${index + 1}`;
        overlayLog('parsed PoseArray point', { topic, index, x, y, position });
        return [{ kind: 'point', x, y, radius: 6, label, color: this.getTopicColor(topic) }];
    }

    private parseFloatArrayOverlay(topic: string, values: number[]): OverlayAnnotation[] {
        if (values.length < 2) return [];

        if (/point/i.test(topic)) {
            const [x, y, radiusValue] = values;
            const point = {
                x,
                y,
                radius: radiusValue ?? 5,
                label: `${topic.split('/').pop() || 'point'}`
            };
            if (this.shouldSkipConfidence(undefined)) return [];
            overlayLog('parsed point array', { topic, values, point });
            return [{ kind: 'point', ...point, color: this.getTopicColor(topic) }];
        }

        if (/bbox/i.test(topic)) {
            if (values.length >= 4) {
                const [a, b, c, d, confidence] = values;
                if (this.shouldSkipConfidence(confidence)) return [];
                const useMinMax = c > a && d > b && (c - a > 0) && (d - b > 0);
                const bbox = useMinMax
                    ? { x: a, y: b, width: c - a, height: d - b, confidence }
                    : { x: a, y: b, width: c, height: d, confidence };
                overlayLog('parsed bbox array', { topic, values, useMinMax, bbox });
                return [{ kind: 'bbox', ...bbox, color: this.getTopicColor(topic) }];
            }

            if (values.length === 2) {
                const [x, y] = values;
                overlayLog('parsed bbox array as point', { topic, values });
                return [{ kind: 'point', x, y, radius: 5, label: undefined, color: this.getTopicColor(topic) }];
            }
        }

        if (values.length >= 4) {
            const [x, y, width, height, confidence] = values;
            if (this.shouldSkipConfidence(confidence)) return [];
            overlayLog('parsed generic numeric overlay as bbox', { topic, values });
            return [{ kind: 'bbox', x, y, width, height, confidence, color: this.getTopicColor(topic) }];
        }

        if (values.length === 2) {
            const [x, y] = values;
            overlayLog('parsed generic numeric overlay as point', { topic, values });
            return [{ kind: 'point', x, y, radius: 5, label: `${topic.split('/').pop() || 'overlay'}`, color: this.getTopicColor(topic) }];
        }

        return [];
    }

    private readNumericSequence(value: any): number[] {
        if (Array.isArray(value)) {
            return value.filter(item => typeof item === 'number' && Number.isFinite(item));
        }

        if (ArrayBuffer.isView(value)) {
            return Array.from(value as unknown as ArrayLike<number>).filter(item => typeof item === 'number' && Number.isFinite(item));
        }

        return [];
    }

    private readNumericSequenceFromObject(value: Record<string, any>): number[] {
        const numericKeys = Object.keys(value)
            .filter(key => /^\d+$/.test(key))
            .map(key => Number(key))
            .sort((a, b) => a - b);

        if (numericKeys.length === 0) return [];

        return numericKeys
            .map(index => value[String(index)])
            .filter(item => typeof item === 'number' && Number.isFinite(item));
    }

    private unwrapOverlayPayload(rawMsg: any): any {
        if (!rawMsg || typeof rawMsg !== 'object') return rawMsg;
        if ('data' in rawMsg && Object.keys(rawMsg).length === 1) return rawMsg.data;
        if ('data' in rawMsg && typeof rawMsg.data !== 'undefined') return rawMsg.data;
        return rawMsg;
    }

    private summarizeOverlayPayload(payload: any): any {
        if (payload == null) return payload;
        if (Array.isArray(payload)) {
            return payload.slice(0, 8);
        }
        if (typeof payload === 'object') {
            const record = payload as Record<string, any>;
            const summary: Record<string, any> = {};
            for (const key of Object.keys(record).slice(0, 8)) {
                const value = record[key];
                summary[key] = Array.isArray(value) ? value.slice(0, 8) : value;
            }
            return summary;
        }
        return payload;
    }

    private normalizeOverlayTopicToken(topic: string): string {
        return topic
            .replace(/^\/+/, '')
            .replace(/\/(color|image_raw|compressed|raw)(\/.*)?$/i, '')
            .replace(/^(bbox|points?|point)[_\-]+/i, '')
            .replace(/^(bbox|points?|point)/i, '')
            .replace(/[_\-]+(bbox|points?|point)$/i, '')
            .replace(/[_\-]+/g, '_')
            .toLowerCase();
    }

    private isPointLike(topic: string, payload: Record<string, any>): boolean {
        return /(^|\/)point/i.test(topic)
            || (this.readNumber(payload.x) !== null && this.readNumber(payload.y) !== null)
            || (this.readNumber(payload.u) !== null && this.readNumber(payload.v) !== null)
            || (this.readNumber(payload.px) !== null && this.readNumber(payload.py) !== null)
            || (this.readNumber(payload.cx) !== null && this.readNumber(payload.cy) !== null)
            || (this.readNumber(payload.center_x) !== null && this.readNumber(payload.center_y) !== null)
            || Boolean(payload.position || payload.center || payload.point || payload.pose);
    }

    private isBoxLike(topic: string, payload: Record<string, any>): boolean {
        return /(^|\/)bbox/i.test(topic)
            || Boolean(payload.bbox || payload.box || payload.rect)
            || ((this.readNumber(payload.x) !== null && this.readNumber(payload.y) !== null) && (this.readNumber(payload.width) !== null || this.readNumber(payload.w) !== null || this.readNumber(payload.height) !== null || this.readNumber(payload.h) !== null))
            || ((this.readNumber(payload.cx) !== null && this.readNumber(payload.cy) !== null) && (this.readNumber(payload.width) !== null || this.readNumber(payload.w) !== null || this.readNumber(payload.height) !== null || this.readNumber(payload.h) !== null))
            || ((this.readNumber(payload.center_x) !== null && this.readNumber(payload.center_y) !== null) && (this.readNumber(payload.width) !== null || this.readNumber(payload.w) !== null || this.readNumber(payload.height) !== null || this.readNumber(payload.h) !== null))
            || ((this.readNumber(payload.xmin) !== null && this.readNumber(payload.ymin) !== null) && (this.readNumber(payload.xmax) !== null || this.readNumber(payload.right) !== null) && (this.readNumber(payload.ymax) !== null || this.readNumber(payload.bottom) !== null));
    }

    private extractPoint(payload: Record<string, any>): Omit<OverlayAnnotation, 'kind' | 'color'> | null {
        const nested = payload.position || payload.center || payload.point || payload.location;
        const x = this.readNumber(payload.x) ?? this.readNumber(payload.u) ?? this.readNumber(payload.px) ?? this.readNumber(payload.cx) ?? this.readNumber(payload.center_x) ?? this.readNumber(nested?.x) ?? this.readNumber(nested?.u);
        const y = this.readNumber(payload.y) ?? this.readNumber(payload.v) ?? this.readNumber(payload.py) ?? this.readNumber(payload.cy) ?? this.readNumber(payload.center_y) ?? this.readNumber(nested?.y) ?? this.readNumber(nested?.v);
        if (x === null || y === null) return null;

        if (this.shouldSkipConfidence(this.readNumber(payload.confidence) ?? this.readNumber(payload.score))) return null;

        return {
            x,
            y,
            radius: this.readNumber(payload.radius) ?? this.readNumber(payload.r) ?? this.readNumber(payload.size) ?? 5,
            label: this.readLabel(payload),
            confidence: this.readNumber(payload.confidence) ?? this.readNumber(payload.score) ?? undefined
        };
    }

    private extractOverlayConfidence(rawMsg: any): number | null {
        const payload = this.unwrapOverlayPayload(rawMsg);
        if (payload == null) return null;

        if (Array.isArray(payload)) {
            if (payload.length >= 5 && typeof payload[4] === 'number') return payload[4];
            return null;
        }

        if (typeof payload !== 'object') return null;

        const record = payload as Record<string, any>;
        const numericObjectData = this.readNumericSequenceFromObject(record);
        if (numericObjectData.length >= 5) {
            return numericObjectData[4];
        }

        const dataSequence = this.readNumericSequence(record.data);
        if (dataSequence.length >= 5) {
            return dataSequence[4];
        }

        const confidence = this.readNumber(record.confidence) ?? this.readNumber(record.score);
        return confidence;
    }

    private extractBbox(payload: Record<string, any>): Omit<OverlayAnnotation, 'kind' | 'color'> | null {
        const nested = payload.bbox || payload.box || payload.rect;
        const source = nested && typeof nested === 'object' ? nested : payload;

        const x = this.readNumber(source.x) ?? this.readNumber(source.cx) ?? this.readNumber(source.center_x) ?? this.readNumber(source.xmin) ?? this.readNumber(source.left) ?? this.readNumber(source.x1);
        const y = this.readNumber(source.y) ?? this.readNumber(source.cy) ?? this.readNumber(source.center_y) ?? this.readNumber(source.ymin) ?? this.readNumber(source.top) ?? this.readNumber(source.y1);
        if (x === null || y === null) return null;

        if (this.shouldSkipConfidence(this.readNumber(payload.confidence) ?? this.readNumber(payload.score))) return null;

        const width = this.readNumber(source.width) ?? this.readNumber(source.w) ?? (this.readNumber(source.xmax) !== null ? (this.readNumber(source.xmax)! - x) : null) ?? (this.readNumber(source.right) !== null ? (this.readNumber(source.right)! - x) : null) ?? (this.readNumber(source.x2) !== null ? (this.readNumber(source.x2)! - x) : null);
        const height = this.readNumber(source.height) ?? this.readNumber(source.h) ?? (this.readNumber(source.ymax) !== null ? (this.readNumber(source.ymax)! - y) : null) ?? (this.readNumber(source.bottom) !== null ? (this.readNumber(source.bottom)! - y) : null) ?? (this.readNumber(source.y2) !== null ? (this.readNumber(source.y2)! - y) : null);

        if (width === null || height === null) return null;

        return {
            x,
            y,
            width,
            height,
            label: this.readLabel(payload),
            confidence: this.readNumber(payload.confidence) ?? this.readNumber(payload.score) ?? undefined
        };
    }

    private readLabel(payload: Record<string, any>): string | undefined {
        const value = payload.label ?? payload.name ?? payload.class ?? payload.text ?? payload.id;
        return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
    }

    private shouldSkipConfidence(confidence: number | null | undefined): boolean {
        return confidence === 0;
    }

    private readNumber(value: any): number | null {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }

    private getTopicColor(topic: string): string {
        let hash = 0;
        for (let i = 0; i < topic.length; i++) {
            hash = ((hash << 5) - hash + topic.charCodeAt(i)) | 0;
        }
        const hue = Math.abs(hash) % 360;
        return `hsl(${hue}, 90%, 60%)`;
    }

    private drawOverlays(ctx: CanvasRenderingContext2D, overlays: OverlayAnnotation[], width: number, height: number) {
        if (overlays.length === 0) return;

        ctx.save();
        ctx.lineWidth = Math.max(2, Math.round(Math.min(width, height) / 240));
        ctx.font = `${Math.max(14, Math.round(Math.min(width, height) / 28))}px monospace`;
        ctx.textBaseline = 'top';

        for (const overlay of overlays) {
            ctx.strokeStyle = overlay.color;
            ctx.fillStyle = overlay.color;
            ctx.shadowColor = overlay.color;
            ctx.shadowBlur = 8;

            if (overlay.kind === 'bbox' && overlay.width !== undefined && overlay.height !== undefined) {
                const normalized = Math.abs(overlay.x) <= 1.5 && Math.abs(overlay.y) <= 1.5 && Math.abs(overlay.width) <= 1.5 && Math.abs(overlay.height) <= 1.5;
                const x = normalized ? overlay.x * width : overlay.x;
                const y = normalized ? overlay.y * height : overlay.y;
                const boxWidth = normalized ? overlay.width * width : overlay.width;
                const boxHeight = normalized ? overlay.height * height : overlay.height;
                ctx.strokeRect(x, y, boxWidth, boxHeight);
                const label = this.formatOverlayLabel(overlay);
                if (label) {
                    const textWidth = ctx.measureText(label).width;
                    const labelHeight = Math.max(18, Math.round(ctx.lineWidth * 6));
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                    ctx.fillRect(x, Math.max(0, y - labelHeight), textWidth + 10, labelHeight);
                    ctx.fillStyle = overlay.color;
                    ctx.fillText(label, x + 5, Math.max(0, y - labelHeight + 2));
                }
            }

            if (overlay.kind === 'point') {
                const normalized = Math.abs(overlay.x) <= 1.5 && Math.abs(overlay.y) <= 1.5;
                const x = normalized ? overlay.x * width : overlay.x;
                const y = normalized ? overlay.y * height : overlay.y;
                const radius = overlay.radius ? (normalized ? overlay.radius * Math.min(width, height) : overlay.radius) : Math.max(4, Math.round(Math.min(width, height) / 160));
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.fillStyle = overlay.color;
                ctx.fill();
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = Math.max(1, Math.round(ctx.lineWidth / 2));
                ctx.stroke();

                const label = this.formatOverlayLabel(overlay);
                if (label) {
                    const textWidth = ctx.measureText(label).width;
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                    ctx.fillRect(x + radius + 4, Math.max(0, y - 4), textWidth + 10, 18);
                    ctx.fillStyle = overlay.color;
                    ctx.fillText(label, x + radius + 9, Math.max(0, y - 2));
                }
            }
        }

        ctx.restore();
    }

    private formatOverlayLabel(overlay: OverlayAnnotation): string {
        const parts: string[] = [];
        if (overlay.label) parts.push(overlay.label);
        if (typeof overlay.confidence === 'number') parts.push(`${Math.round(overlay.confidence * 100)}%`);
        return parts.join(' ');
    }
}
