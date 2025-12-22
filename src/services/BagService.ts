import { Bag } from '@foxglove/rosbag';
import { ImageProcessor } from './ImageProcessor';

// --- Interfaces ---
interface Time {
    sec: number;
    nsec: number;
}

export interface JointStateMsg {
    name?: string[];
    position: number[];
    velocity: number[];
    effort: number[];
}

export type ParsedFrame = {
    timestamp: number;
    index: number;
    images: Record<string, string>;
    jointState: JointStateMsg | null;
};

export type JointDataPoint = {
    position: number[];
    velocity: number[];
    effort: number[];
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
    data?: any; // Joint 数据需要存下来，Image 只需要时间戳
}

export class BagService {
    private bag: Bag | null = null;
    private imageProcessor = new ImageProcessor();

    // --- Public State ---
    public timestamps: number[] = []; 
    public topicMetadata: Record<string, { msgType: string; title: string }> = {};
    public historicalJointData: Map<number, JointDataPoint> = new Map();

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
            }
            
            // 对 topic 排序以保证一致性 (参考代码逻辑)
            this.imageTopics.sort();
            this.jointTopics.sort();

            const targetTopics = [...this.imageTopics, ...this.jointTopics];
            if (targetTopics.length === 0) throw new Error("No compatible topics found.");

            // 2. Extract All Messages (预读所有 Joint 数据 + Image 的时间戳)
            onProgress?.('Scanning Messages...');
            
            const allMessages: LightMessage[] = [];
            
            // 使用迭代器读取所有目标消息
            for await (const msg of this.bag.messageIterator({ topics: targetTopics })) {
                const ts = this.timeToMs(msg.timestamp);
                const lightMsg: LightMessage = {
                    timestamp: ts,
                    originalTime: msg.timestamp,
                    topic: msg.topic
                };

                // 如果是 Joint，我们需要把数据存下来用于 ZOH
                if (this.jointTopics.includes(msg.topic)) {
                    lightMsg.data = msg.message;
                }
                // 如果是 Image，我们只需要知道它在这一刻存在即可，不需要存 data

                allMessages.push(lightMsg);
            }

            if (allMessages.length === 0) throw new Error("No messages found.");

            // 按时间排序
            allMessages.sort((a, b) => a.timestamp - b.timestamp);

            // 3. Bootstrapping (关键步骤：寻找“完全就绪”的时间点)
            onProgress?.('Aligning Timeline...');
            
            const seenTopics = new Set<string>();
            let startMsgIndex = 0;
            let firstFullStateTime: number | null = null;
            
            // 初始状态累加器
            const currentJoints: Record<string, any> = {}; 
            const currentImageTimes = new Map<string, Time>();

            // 遍历消息直到集齐所有 Topic
            for (let i = 0; i < allMessages.length; i++) {
                const msg = allMessages[i];
                seenTopics.add(msg.topic);

                // 更新初始状态
                if (this.jointTopics.includes(msg.topic)) {
                    currentJoints[msg.topic] = msg.data;
                } else {
                    currentImageTimes.set(msg.topic, msg.originalTime);
                }

                // 检查是否所有目标 Topic 都已出现
                const allReady = targetTopics.every(t => seenTopics.has(t));
                if (allReady) {
                    firstFullStateTime = msg.timestamp;
                    startMsgIndex = i; // 从这里开始后面的回放
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
            
            // 从 firstFullStateTime 开始生成时间轴
            for (let t = firstFullStateTime; t <= endTime; t += 33.33) {
                const frameTime = Math.round(t);
                const frameIdx = this.timestamps.length;
                this.timestamps.push(frameTime);

                // 追赶消息指针：处理所有 <= 当前帧时间的消息
                while (msgCursor < allMessages.length && allMessages[msgCursor].timestamp <= t) {
                    const msg = allMessages[msgCursor];
                    
                    // 更新“当前状态”
                    if (this.jointTopics.includes(msg.topic)) {
                        currentJoints[msg.topic] = msg.data;
                    } else {
                        currentImageTimes.set(msg.topic, msg.originalTime);
                    }
                    
                    msgCursor++;
                }

                // Snapshot: 保存当前帧的“状态快照”
                
                // A. 保存 Joint 数据 (合并左右臂)
                this.snapshotJointData(frameIdx, currentJoints);

                // B. 保存 Image 索引 (深拷贝 Map)
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
        // 这里根据你的实际 Topic 名称做合并
        // 注意：这里要做防御性编程，因为 Bootstrapping 保证了都有值，但最好还是给个空数组默认值
        const leftData = currentJoints["/puppet/joint_left"] || { position: [], velocity: [], effort: [] };
        const rightData = currentJoints["/puppet/joint_right"] || { position: [], velocity: [], effort: [] };

        this.historicalJointData.set(frameIdx, {
            position: [...(leftData.position || []), ...(rightData.position || [])],
            velocity: [...(leftData.velocity || []), ...(rightData.velocity || [])],
            effort: [...(leftData.effort || []), ...(rightData.effort || [])]
        });
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

    // --- getFrameAt 保持大部分逻辑不变，因为索引已经建立好了 ---
    async getFrameAt(index: number): Promise<ParsedFrame | null> {
        if (!this.bag || index < 0 || index >= this.timestamps.length) return null;

        const targetTs = this.timestamps[index];
        if (this.frameCache.has(targetTs)) return this.frameCache.get(targetTs)!;

        const frameData: ParsedFrame = {
            timestamp: targetTs,
            index,
            images: {},
            jointState: null
        };

        // 1. 填充关节 (直接从 Map 取，已经是 O(1) 了)
        const jointData = this.historicalJointData.get(index);
        if (jointData) {
            frameData.jointState = {
                name: [], // 如果需要名字，可以在 snapshot 时也合并名字
                position: jointData.position,
                velocity: jointData.velocity,
                effort: jointData.effort
            };
        }

        // 2. 填充图片 (IO)
        const imageSnapshot = this.frameImageIndex.get(index);
        
        if (imageSnapshot && imageSnapshot.size > 0) {
            const promises = Array.from(imageSnapshot.entries()).map(async ([topic, exactTime]) => {
                // 读取逻辑... (保持你原来的代码逻辑，读取单条)
                try {
                     const iter = this.bag!.messageIterator({
                        topics: [topic],
                        start: exactTime,
                        // end: exactTime // Foxglove 有时不支持精确 end，依赖 break
                    });

                    for await (const msg of iter) {
                        // 校验时间戳是否匹配（防止读到后面的图）
                        // 在 ZOH 逻辑下，我们存的是 <= frameTime 的最新图
                        // 所以读出来的这张图的 timestamp 应该等于 exactTime
                        // 稍微容错一下
                        const msgTime = msg.timestamp;
                        if (msgTime.sec === exactTime.sec && msgTime.nsec === exactTime.nsec) {
                             const msgAny = msg.message as any;
                             // ... 解码逻辑 (保持不变)
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
                        break; // 读到一条即走
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