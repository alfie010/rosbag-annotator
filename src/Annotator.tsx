import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    type ChartOptions
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';

// --- Imports (Adjust paths as needed) ---
import { BagService, type ParsedFrame, type JointStateMsg } from './services/BagService';
import UrdfViewer from './components/urdf/UrdfViewer';
import { UrdfSettingsDialog, PIPER_CONFIG } from './components/dialogs/UrdfSettingsDialog';
import type { UrdfConfig } from './components/urdf/UrdfViewer';

// --- Register ChartJS ---
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, annotationPlugin);

// --- Types ---
interface SubtaskAnnotation {
    id: string;
    username: string;
    start: number;
    end: number;
    quality: 'good' | 'bad' | 'accident' | null;
    prompt: string;
}

interface ContactAnnotation {
    id: string;
    username: string;
    start: number;
    end: number;
}

interface DraggingState {
    type: 'contact';
    id: string;
    edge: 'start' | 'end';
}

// --- Constants ---
const PROMPT_OPTIONS = {
    actions: ['pick', 'place', 'move', 'push', 'wipe', 'hold'],
    adjectives: ['red', 'blue', 'metal', 'wooden', 'soft', 'heavy'],
    objects: ['cube', 'block', 'apple', 'banana', 'cloth', 'tool']
};

const MIN_CONTACT_FRAMES = 5;

const PLACEHOLDER_IMG = 'data:image/svg+xml;charset=UTF-8,%3csvg xmlns="http://www.w3.org/2000/svg" width="640" height="480"%3e%3crect width="100%25" height="100%25" fill="%230f172a"/%3e%3ctext x="50%25" y="50%25" fill="%23334155" font-family="monospace" font-size="20px" dominant-baseline="middle" text-anchor="middle"%3eNO SIGNAL%3c/text%3e%3c/svg%3e';

// --- Helpers ---
const generateUniqueId = () => `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

const formatTime = (ms: number): string => {
    if (isNaN(ms) || ms < 0) return '00:00.000';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = Math.floor(ms % 1000);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
};

// --- Main Component ---
const AnnotationPage: React.FC = () => {
    // --- Services ---
    const [bagService] = useState(() => new BagService());

    // --- State: Settings ---
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [urdfConfig, setUrdfConfig] = useState<UrdfConfig>(PIPER_CONFIG);

    // --- State: File & Data ---
    const [isFileLoaded, setIsFileLoaded] = useState(false);
    const [fileName, setFileName] = useState('');
    const [timestamps, setTimestamps] = useState<number[]>([]);
    const [topicMetadata, setTopicMetadata] = useState<any | null>(null);
    const [isLoadingBag, setIsLoadingBag] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [isDragOver, setIsDragOver] = useState(false);

    // --- State: Playback ---
    const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [displayedFrame, setDisplayedFrame] = useState<ParsedFrame | null>(null);

    // --- State: Visuals ---
    const [orderedImageTopics, setOrderedImageTopics] = useState<string[]>([]);
    const [draggedTopic, setDraggedTopic] = useState<string | null>(null);
    const [historicalJointData, setHistoricalJointData] = useState<Map<number, Record<string, JointStateMsg>>>(new Map());
    const [availableJointNames, setAvailableJointNames] = useState<string[]>([]);

    // Joint Graph Settings
    const [selectedJointDataType, setSelectedJointDataType] = useState<'position' | 'velocity' | 'effort'>('position');
    const [selectedJointsToChart, setSelectedJointsToChart] = useState<string[]>([]);

    // --- State: Annotation ---
    const [subtasks, setSubtasks] = useState<SubtaskAnnotation[]>([]);
    const [contacts, setContacts] = useState<ContactAnnotation[]>([]);
    const [selectedSubtaskId, setSelectedSubtaskId] = useState<string | null>(null);
    const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
    const [pendingContactStart, setPendingContactStart] = useState<number | null>(null);

    // --- State: Interaction ---
    const [hoveredFrame, setHoveredFrame] = useState<{ index: number | null, percent: number }>({ index: null, percent: 0 });
    const [draggingState, setDraggingState] = useState<DraggingState | null>(null);
    const [genSelection, setGenSelection] = useState({ action: '', adjective: '', object: '' });

    // --- Refs ---
    const playbackInterval = useRef<number | null>(null);
    const timelineInnerRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 1. File Handling
    const loadBagFile = async (file: File) => {
        setFileName(file.name);
        setIsLoadingBag(true);
        setLoadingMessage('Initializing Reader...');

        // --- RESET STATE ---
        setContacts([]);      // Clear contacts
        setSubtasks([]);     // Clear subtasks
        setSelectedContactId(null);
        setSelectedSubtaskId(null);
        // -------------------

        try {
            await bagService.loadFile(file, (msg) => setLoadingMessage(msg));
            setTimestamps(bagService.timestamps);
            setTopicMetadata(bagService.topicMetadata);

            // 1. Get the raw data map
            const history = bagService.historicalJointData;
            setHistoricalJointData(history);

            // 2. Discover Joints Dynamically
            // Look at the first frame that has data
            const firstData = history.get(0);
            const foundJoints: string[] = [];

            if (firstData) {
                // Iterate over all topics in this frame (e.g., /joint_states)
                Object.entries(firstData).forEach(([topic, msg]) => {
                    if (msg.name && Array.isArray(msg.name) && msg.name.length > 0) {
                        msg.name.forEach(name => {
                            foundJoints.push(`${topic}/${name}`);
                        });
                    }
                });
            }

            setAvailableJointNames(foundJoints);

            // Default: Select first 6 joints for the chart to avoid overcrowding
            setSelectedJointsToChart(foundJoints.slice(0, 6));

            const allImageTopics = Object.keys(bagService.topicMetadata)
                .filter(k => bagService.topicMetadata[k].msgType.includes('Image'))
                .sort();
            // Try to recover layout from LocalStorage
            const topicKeysString = Object.keys(bagService.topicMetadata).sort().join('-');
            const savedLayoutJson = localStorage.getItem(`rosbag-layout-${topicKeysString}`);

            if (savedLayoutJson) {
                try {
                    const savedLayout = JSON.parse(savedLayoutJson);
                    // Filter out any saved topics that might not exist in this specific bag (safety check)
                    const validSaved = savedLayout.filter((t: string) => allImageTopics.includes(t));
                    // Add any new topics that weren't in the saved layout
                    const missing = allImageTopics.filter(t => !validSaved.includes(t));
                    setOrderedImageTopics([...validSaved, ...missing]);
                } catch (e) {
                    setOrderedImageTopics(allImageTopics);
                }
            } else {
                setOrderedImageTopics(allImageTopics);
            }

            const frame0 = await bagService.getFrameAt(0);
            setDisplayedFrame(frame0);
            setCurrentFrameIndex(0);

            // Default Subtask
            setSubtasks([{
                id: generateUniqueId(),
                username: 'local',
                start: 0,
                end: bagService.timestamps.length - 1,
                quality: null,
                prompt: ''
            }]);

            setIsFileLoaded(true);
        } catch (err: any) {
            console.error(err);
            alert(`Error loading bag: ${err.message}`);
        } finally {
            setIsLoadingBag(false);
            setIsDragOver(false);
        }
    };

    const handleGlobalDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        // Only trigger if dragging files, NOT if dragging internal elements (like images)
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragOver(true);
        }
    };
    const handleGlobalDragLeave = () => setIsDragOver(false);
    const handleGlobalDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        if (e.dataTransfer.files?.[0]?.name.endsWith('.bag')) loadBagFile(e.dataTransfer.files[0]);
    };

    const handleExportJSON = () => {
        const data = {
            filename: fileName,
            metadata: {
                totalFrames: timestamps.length,
                duration: timestamps.length > 0 ? timestamps[timestamps.length - 1] - timestamps[0] : 0
            },
            subtasks,
            contacts
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `annotation_${fileName.replace('.bag', '')}_${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // 2. Playback System
    const fetchFrame = useCallback(async (idx: number) => {
        const frame = await bagService.getFrameAt(idx);
        if (frame) setDisplayedFrame(frame);
    }, [bagService]);

    const togglePlayback = () => {
        if (isPlaying) setIsPlaying(false);
        else {
            if (currentFrameIndex >= timestamps.length - 1) {
                setCurrentFrameIndex(0);
                fetchFrame(0);
            }
            setIsPlaying(true);
        }
    };

    useEffect(() => {
        if (isPlaying && timestamps.length > 0) {
            playbackInterval.current = window.setInterval(() => {
                setCurrentFrameIndex(prev => {
                    if (prev + 1 >= timestamps.length) {
                        setIsPlaying(false);
                        return prev;
                    }
                    const next = prev + 1;
                    fetchFrame(next);
                    return next;
                });
            }, 33);
        } else if (playbackInterval.current) {
            clearInterval(playbackInterval.current);
        }
        return () => { if (playbackInterval.current) clearInterval(playbackInterval.current); };
    }, [isPlaying, timestamps.length, fetchFrame]);

    useEffect(() => {
        if (!isPlaying) fetchFrame(currentFrameIndex);
    }, [currentFrameIndex, isPlaying, fetchFrame]);

    // 3. Image Layout Drag
    const handleImageDragStart = (e: React.DragEvent, topic: string) => {
        e.stopPropagation(); // CRITICAL: Stop propagation so global file drop doesn't trigger
        setDraggedTopic(topic);
        e.dataTransfer.setData("text/plain", topic);
        e.dataTransfer.effectAllowed = "move";
    };

    const handleImageDrop = (e: React.DragEvent, target: string) => {
        e.preventDefault(); e.stopPropagation();
        const source = e.dataTransfer.getData("text/plain");
        if (source && source !== target) {
            const newOrder = [...orderedImageTopics];
            const sIdx = newOrder.indexOf(source);
            const tIdx = newOrder.indexOf(target);
            if (sIdx > -1 && tIdx > -1) {
                newOrder.splice(tIdx, 0, newOrder.splice(sIdx, 1)[0]);
                setOrderedImageTopics(newOrder);
            }
        }
        setDraggedTopic(null);
    };

    useEffect(() => {
        if (orderedImageTopics.length > 0 && isFileLoaded && topicMetadata) {
            // Create a unique key based on the structure of topics in the bag
            const topicKeysString = Object.keys(topicMetadata).sort().join('-');
            localStorage.setItem(`rosbag-layout-${topicKeysString}`, JSON.stringify(orderedImageTopics));
        }
    }, [orderedImageTopics, isFileLoaded, topicMetadata]);

    // 4. Annotation Logic (Subtasks & Contacts)

    // --- Subtask ---
    const handleSubtaskChange = (val: string) => {
        setSubtasks(prev => prev.map(s => s.id === selectedSubtaskId ? { ...s, prompt: val } : s));
    };

    const updateGenPrompt = (k: string, v: string) => {
        const next = { ...genSelection, [k]: v };
        setGenSelection(next);
        if (next.action && next.object) {
            handleSubtaskChange(`${next.action} the ${next.adjective} ${next.object}`.replace(/\s+/g, ' ').trim());
        }
    };

    const handleMergeSubtask = (direction: 'prev' | 'next') => {
        if (!selectedSubtaskId) return;
        const index = subtasks.findIndex(s => s.id === selectedSubtaskId);
        if (index === -1) return;

        const current = subtasks[index];
        let newList = [...subtasks];

        if (direction === 'prev' && index > 0) {
            const prev = subtasks[index - 1];
            // Merge prev into current (extend start)
            newList[index] = { ...current, start: prev.start };
            newList.splice(index - 1, 1); // Remove prev
        } else if (direction === 'next' && index < subtasks.length - 1) {
            const next = subtasks[index + 1];
            // Merge next into current (extend end)
            newList[index] = { ...current, end: next.end };
            newList.splice(index + 1, 1); // Remove next
        }

        setSubtasks(newList);
    };

    const handleSubtaskContextMenu = (e: React.MouseEvent) => {
        e.preventDefault(); e.stopPropagation();
        if (hoveredFrame.index === null) return;
        const idx = hoveredFrame.index;
        const target = subtasks.findIndex(s => s.start < idx && s.end > idx);
        if (target !== -1) {
            const old = subtasks[target];
            const newL = { ...old, id: generateUniqueId(), end: idx - 1 };
            const newR = { ...old, id: generateUniqueId(), start: idx };
            const list = [...subtasks];
            list.splice(target, 1, newL, newR);
            setSubtasks(list);
        }
    };

    // --- Contact Creation Logic ---
    const finishContactCreation = (endIndex: number) => {
        if (pendingContactStart === null) return;
        let start = Math.min(pendingContactStart, endIndex);
        let end = Math.max(pendingContactStart, endIndex);
        if (end - start < MIN_CONTACT_FRAMES) end = Math.min(timestamps.length - 1, start + MIN_CONTACT_FRAMES);

        setContacts([...contacts, { id: generateUniqueId(), username: 'local', start, end }]);
        setPendingContactStart(null);
    };

    const handleContactTrackContextMenu = (e: React.MouseEvent) => {
        e.preventDefault(); e.stopPropagation();
        if (hoveredFrame.index === null) return;

        if (pendingContactStart === null) {
            setPendingContactStart(hoveredFrame.index);
        } else {
            finishContactCreation(hoveredFrame.index);
        }
    };

    const handleContactTrackClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (pendingContactStart !== null && hoveredFrame.index !== null) {
            finishContactCreation(hoveredFrame.index);
        } else {
            handleTimelineClick(e);
            setSelectedContactId(null);
        }
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Only trigger if a contact is selected and we are not typing in an input
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedContactId) {
                const activeElement = document.activeElement;
                const isInput = activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA';

                if (!isInput) {
                    handleDeleteContact();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedContactId]); // Re-bind when selection changes

    // --- Contact Dragging/Resizing Logic ---
    const handleMouseDownOnHandle = (e: React.MouseEvent, type: 'contact', id: string, edge: 'start' | 'end') => {
        e.stopPropagation(); e.preventDefault();
        setDraggingState({ type, id, edge });
    };

    // Global Drag Effect for Timeline
    useEffect(() => {
        const handleGlobalMouseMove = (e: MouseEvent) => {
            if (!draggingState || !timelineInnerRef.current || timestamps.length === 0) return;
            const rect = timelineInnerRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const newIndex = Math.round((x / rect.width) * (timestamps.length - 1));
            const clampedIndex = Math.max(0, Math.min(timestamps.length - 1, newIndex));

            if (draggingState.type === 'contact') {
                setContacts(prev => prev.map(c => {
                    if (c.id !== draggingState.id) return c;
                    const newC = { ...c };
                    if (draggingState.edge === 'start') {
                        newC.start = Math.min(clampedIndex, c.end - MIN_CONTACT_FRAMES);
                    } else {
                        newC.end = Math.max(clampedIndex, c.start + MIN_CONTACT_FRAMES);
                    }
                    return newC;
                }));
            }
        };

        const handleGlobalMouseUp = () => {
            if (draggingState) setDraggingState(null);
        };

        if (draggingState) {
            window.addEventListener('mousemove', handleGlobalMouseMove);
            window.addEventListener('mouseup', handleGlobalMouseUp);
        }
        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [draggingState, timestamps]);

    const handleDeleteContact = () => {
        if (!selectedContactId) return;
        setContacts(prev => prev.filter(c => c.id !== selectedContactId));
        setSelectedContactId(null);
    };


    // 5. Timeline General Handlers
    const handleTimelineClick = (e: React.MouseEvent) => {
        if (!timelineInnerRef.current || timestamps.length === 0) return;
        const rect = timelineInnerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const index = Math.min(Math.max(0, Math.round((x / rect.width) * (timestamps.length - 1))), timestamps.length - 1);

        setCurrentFrameIndex(index);
        setIsPlaying(false);

        const sub = subtasks.find(s => index >= s.start && index <= s.end);
        setSelectedSubtaskId(sub ? sub.id : null);
        const contact = contacts.find(c => index >= c.start && index <= c.end);
        setSelectedContactId(contact ? contact.id : null);
    };

    const handleTimelineMouseMove = (e: React.MouseEvent) => {
        if (!timelineInnerRef.current || timestamps.length === 0) return;
        const rect = timelineInnerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percent = Math.max(0, Math.min(100, (x / rect.width) * 100));
        const frameIndex = Math.round((x / rect.width) * (timestamps.length - 1));
        setHoveredFrame({ index: frameIndex, percent });
    };

    const handleTimelineMouseLeave = () => {
        setHoveredFrame({ index: null, percent: 0 });
    };

    // 6. Chart Logic

    // --- Helper: Group joints by topic for batch selection ---
    const uniqueTopics = useMemo(() => {
        const topics = new Set(availableJointNames.map(n => n.substring(0, n.lastIndexOf('/'))));
        return Array.from(topics).sort();
    }, [availableJointNames]);

    const toggleTopic = (topic: string) => {
        const jointsInTopic = availableJointNames.filter(n => n.startsWith(topic + '/'));
        // Check if all joints in this topic are currently selected
        const isAllSelected = jointsInTopic.every(j => selectedJointsToChart.includes(j));

        if (isAllSelected) {
            // Deselect all
            setSelectedJointsToChart(prev => prev.filter(j => !jointsInTopic.includes(j)));
        } else {
            // Select all (Union)
            setSelectedJointsToChart(prev => Array.from(new Set([...prev, ...jointsInTopic])));
        }
    };

    // --- Chart Data & Options ---
    const plotData = useMemo(() => {
        if (historicalJointData.size === 0 || availableJointNames.length === 0) {
            return { labels: [], datasets: [] };
        }

        const indices = Array.from(historicalJointData.keys()).sort((a, b) => a - b);
        const labels = indices.map(i => formatTime(timestamps[i] - timestamps[0]));

        const colors = [
            '#22d3ee', '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc',
            '#e879f9', '#f472b6', '#fb7185', '#f87171', '#fb923c', '#fbbf24',
            '#facc15', '#a3e635'
        ];

        const datasets = selectedJointsToChart.map((uniqueId, i) => ({
            label: uniqueId,
            data: indices.map(idx => {
                const frameData = historicalJointData.get(idx);
                if (!frameData) return null;

                for (const topic of Object.keys(frameData)) {
                    const msg = frameData[topic];

                    const pos = msg.name.findIndex(rawName => `${topic}/${rawName}` === uniqueId);

                    if (pos !== -1 && msg[selectedJointDataType]) {
                        return msg[selectedJointDataType][pos];
                    }
                }
                return null;
            }),
            borderColor: colors[i % colors.length],
            backgroundColor: colors[i % colors.length],
            pointRadius: 0,
            borderWidth: 1.2,
            tension: 0.1
        }));

        return { labels, datasets };
    }, [historicalJointData, selectedJointsToChart, selectedJointDataType, timestamps]);

    const plotOptions = useMemo<ChartOptions<'line'>>(() => {
        return {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, labels: { color: '#94a3b8', font: { family: 'monospace', size: 10 }, boxWidth: 10 } },
                tooltip: { enabled: true, backgroundColor: 'rgba(15, 23, 42, 0.9)', titleColor: '#22d3ee', bodyFont: { family: 'monospace' } },
                annotation: {
                    annotations: {
                        // Correctly positions the red line by index because plotData is now 1:1 with frames
                        line1: {
                            type: 'line',
                            xMin: currentFrameIndex,
                            xMax: currentFrameIndex,
                            borderColor: 'rgb(239, 68, 68)',
                            borderWidth: 2,
                            borderDash: [5, 5],
                            label: { display: false }
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#64748b', maxTicksLimit: 8, font: { family: 'monospace', size: 10 } },
                    grid: { color: '#1e293b' }
                },
                y: {
                    ticks: { color: '#64748b', font: { family: 'monospace', size: 10 } },
                    grid: { color: '#1e293b' },
                    title: { display: true, text: selectedJointDataType.toUpperCase(), color: '#475569', font: { size: 10, weight: 'bold' } }
                }
            }
        };
    }, [selectedJointDataType, currentFrameIndex]); // Removed hoveredFrame from dependency to prevent re-renders for white line (which is removed)


    // --- Render ---
    return (
        <div
            className="w-screen h-screen bg-[#050505] text-slate-300 font-mono overflow-hidden flex flex-col relative selection:bg-cyan-500/30"
            onDragOver={handleGlobalDragOver} onDragLeave={handleGlobalDragLeave} onDrop={handleGlobalDrop}
        >
            {/* Global Drag Overlay */}
            {isDragOver && (
                <div className="absolute inset-0 z-[100] bg-cyan-900/40 backdrop-blur-sm border-4 border-cyan-500 border-dashed m-6 rounded-2xl flex flex-col items-center justify-center pointer-events-none shadow-[0_0_100px_rgba(6,182,212,0.2)]">
                    <div className="text-8xl mb-4 animate-bounce">📂</div>
                    <h2 className="text-4xl font-bold text-cyan-400 tracking-widest">DROP BAG FILE HERE</h2>
                </div>
            )}

            {/* Header */}
            <header className="h-12 bg-[#0a0a0a] border-b border-gray-800 flex items-center justify-between px-6 shrink-0 shadow-md z-30">
                <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.8)] animate-pulse"></div>
                    <span className="font-bold text-lg tracking-wider text-gray-100">ROS<span className="text-cyan-500">ANNOTATOR</span></span>
                    {fileName && <span className="ml-4 text-xs font-medium text-gray-400 bg-gray-900 px-3 py-1 rounded-full border border-gray-800">{fileName}</span>}
                </div>
                <div className="flex gap-3">
                    <button onClick={() => setIsSettingsOpen(true)} className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-bold uppercase tracking-wider rounded border border-gray-700">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        Config
                    </button>
                    {isFileLoaded && (
                        <button onClick={handleExportJSON} className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-cyan-400 text-xs font-bold uppercase tracking-wider rounded border border-gray-700 transition-all hover:border-cyan-500/50 hover:shadow-[0_0_15px_rgba(6,182,212,0.1)]">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                            Export JSON
                        </button>
                    )}
                    {!isFileLoaded && <button onClick={() => fileInputRef.current?.click()} className="text-xs bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-1.5 rounded font-bold transition-colors shadow-lg shadow-cyan-900/20">Select File</button>}
                    <input type="file" ref={fileInputRef} accept=".bag" className="hidden" onChange={(e) => e.target.files?.[0] && loadBagFile(e.target.files[0])} />
                </div>
            </header>

            {!isFileLoaded ? (
                <div className="flex-1 flex flex-col items-center justify-center relative bg-gradient-to-b from-[#050505] to-[#0a0a0a]">
                    {isLoadingBag && <div className="absolute inset-0 bg-black/90 z-50 flex flex-col items-center justify-center backdrop-blur-sm"><div className="w-12 h-12 border-4 border-t-transparent border-cyan-500 rounded-full animate-spin mb-4"></div><span className="text-cyan-400 font-mono tracking-widest text-sm animate-pulse">{loadingMessage}</span></div>}
                    <div className="text-center opacity-30 space-y-4 hover:opacity-50 transition-opacity duration-500">
                        <svg className="w-24 h-24 mx-auto text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                        <p className="text-xl font-light tracking-wide text-gray-400">Drag & Drop .bag file to begin</p>
                    </div>
                </div>
            ) : (
                <>
                    <div className="flex-1 flex overflow-hidden">
                        {/* Visualizer Area */}
                        <div className="flex-1 flex flex-col border-r border-gray-800 min-w-0">
                            {/* Images Grid - Forced grid-cols-3 */}
                            <div className="flex-grow bg-[#020202] p-2 grid grid-cols-3 gap-2 overflow-y-auto content-start custom-scrollbar">
                                {orderedImageTopics.map((topic) => (
                                    <div key={topic} draggable onDragStart={(e) => handleImageDragStart(e, topic)} onDrop={(e) => handleImageDrop(e, topic)} onDragOver={(e) => e.preventDefault()}
                                        className={`relative aspect-[4/3] rounded-lg border border-gray-800 bg-gray-900/50 overflow-hidden group transition-all hover:border-gray-600 ${draggedTopic === topic ? 'opacity-40 ring-2 ring-cyan-500 border-transparent' : ''}`}
                                    >
                                        <div className="absolute top-2 left-2 px-2 py-1 bg-black/80 backdrop-blur text-[10px] font-bold text-cyan-400 border border-white/5 rounded shadow-lg z-10 pointer-events-none select-none tracking-tight">
                                            {topicMetadata[topic]?.title || topic}
                                        </div>
                                        <img src={displayedFrame?.images[topic] || PLACEHOLDER_IMG} className="w-full h-full object-contain select-none" alt={topic} />
                                    </div>
                                ))}
                            </div>

                            {/* Charts & URDF */}
                            <div className="h-[320px] bg-[#050505] border-t border-gray-800 flex shrink-0">
                                <div className="w-[33%] border-r border-gray-800 relative bg-gradient-to-b from-gray-900/20 to-transparent">
                                    <div className="absolute top-2 left-3 text-[10px] font-bold text-gray-500 tracking-widest z-10">URDF VISUALIZER</div>
                                    <UrdfViewer
                                        jointData={displayedFrame?.jointStateMap || null}
                                        config={urdfConfig}
                                    />
                                </div>
                                <div className="w-[67%] flex flex-col p-3 min-w-0">
                                    <div className="flex justify-between items-center mb-3">
                                        <div className="flex items-center h-8 max-w-[75%] bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
                                            
                                            {/* 1. Scrolling Area: Individual Joints */}
                                            <div className="flex-1 flex items-center gap-1 overflow-x-auto no-scrollbar px-2 mask-linear-fade">
                                                {availableJointNames.length === 0 && <span className="text-[10px] text-gray-600 italic">No joints found</span>}
                                                {availableJointNames.map(name => {
                                                    const shortName = name.split('/').pop() || name; // Show only 'joint1', etc.
                                                    const isSelected = selectedJointsToChart.includes(name);
                                                    return (
                                                        <button
                                                            key={name}
                                                            onClick={() => setSelectedJointsToChart(prev => isSelected ? prev.filter(j => j !== name) : [...prev, name])}
                                                            className={`
                                                                shrink-0 px-2 py-0.5 text-[9px] border rounded transition-all whitespace-nowrap
                                                                ${isSelected 
                                                                    ? 'bg-cyan-900/40 border-cyan-500/50 text-cyan-400' 
                                                                    : 'bg-transparent border-gray-700 text-gray-500 hover:border-gray-500'}
                                                            `}
                                                            title={name}
                                                        >
                                                            {shortName}
                                                        </button>
                                                    );
                                                })}
                                            </div>

                                            {/* 2. Vertical Divider */}
                                            <div className="w-px h-4 bg-gray-700 mx-1 shrink-0"></div>

                                            {/* 3. Fixed Area: Topics & Global Controls */}
                                            <div className="flex items-center gap-2 px-2 shrink-0 bg-gray-800/50 h-full">
                                                
                                                {/* Topic Groups */}
                                                <div className="flex gap-1">
                                                    {uniqueTopics.map(topic => {
                                                        const jointsInTopic = availableJointNames.filter(n => n.startsWith(topic + '/'));
                                                        const activeCount = jointsInTopic.filter(j => selectedJointsToChart.includes(j)).length;
                                                        const isFull = activeCount === jointsInTopic.length;
                                                        const isPart = activeCount > 0 && !isFull;
                                                        // Display name logic: /puppet/joint_left -> joint_left -> left
                                                        const displayName = topic.split('/').pop()?.replace('joint_', '').toUpperCase().substring(0, 4) || 'GRP';

                                                        return (
                                                            <button 
                                                                key={topic} 
                                                                onClick={() => toggleTopic(topic)}
                                                                className={`
                                                                    px-1.5 py-0.5 text-[8px] font-bold border rounded uppercase tracking-wider
                                                                    ${isFull ? 'bg-indigo-900/50 border-indigo-500 text-indigo-300' : 
                                                                      isPart ? 'bg-indigo-900/20 border-indigo-500/50 text-indigo-400' : 
                                                                      'bg-gray-800 border-gray-600 text-gray-500 hover:text-gray-300'}
                                                                `}
                                                                title={`Toggle all in ${topic}`}
                                                            >
                                                                {displayName}
                                                            </button>
                                                        );
                                                    })}
                                                </div>

                                                {/* All / None */}
                                                <div className="flex gap-1 ml-1">
                                                    <button onClick={() => setSelectedJointsToChart(availableJointNames)} className="text-[9px] font-bold text-gray-400 hover:text-white px-1">ALL</button>
                                                    <span className="text-gray-700 text-[10px]">/</span>
                                                    <button onClick={() => setSelectedJointsToChart([])} className="text-[9px] font-bold text-gray-400 hover:text-white px-1">NONE</button>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Data Type Selector (Pos/Vel/Eff) */}
                                        <div className="flex bg-gray-900 rounded-lg border border-gray-800 p-0.5">
                                            {['position', 'velocity', 'effort'].map(t => (
                                                <button key={t} onClick={() => setSelectedJointDataType(t as any)} className={`px-3 py-0.5 text-[10px] font-bold uppercase rounded-md transition-all ${selectedJointDataType === t ? 'bg-cyan-900/50 text-cyan-400 shadow-sm' : 'text-gray-600 hover:text-gray-400'}`}>{t}</button>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="flex-1 relative w-full h-full min-h-0"><Line data={plotData} options={plotOptions} /></div>
                                </div>
                            </div>
                        </div>

                        {/* Right Sidebar: Annotation Form */}
                        <div className="w-[320px] bg-[#080808] border-l border-gray-800 flex flex-col shrink-0 z-20 shadow-[-5px_0_15px_rgba(0,0,0,0.5)]">
                            <div className="p-4 border-b border-gray-800">
                                <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em] mb-4">Properties</h3>

                                {/* Subtask Panel */}
                                {selectedSubtaskId ? (
                                    <div className="space-y-4 animate-fade-in mb-6">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-bold text-blue-400 flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                                                SUBTASK
                                            </span>
                                            <button onClick={() => setSelectedSubtaskId(null)} className="text-gray-600 hover:text-white transition-colors">✕</button>
                                        </div>

                                        <div className="grid grid-cols-3 gap-1.5">
                                            {['action', 'adjective', 'object'].map(k => (
                                                <select key={k} value={(genSelection as any)[k]} onChange={e => updateGenPrompt(k, e.target.value)} className="w-full bg-gray-900 text-[10px] border border-gray-700 rounded px-1 py-1.5 text-gray-300 outline-none focus:border-blue-500 transition-colors cursor-pointer">
                                                    <option value="">- {k} -</option>{(PROMPT_OPTIONS as any)[k + 's'].map((o: string) => <option key={o} value={o}>{o}</option>)}
                                                </select>
                                            ))}
                                        </div>

                                        <textarea value={subtasks.find(s => s.id === selectedSubtaskId)?.prompt || ''} onChange={e => handleSubtaskChange(e.target.value)} className="w-full h-24 bg-gray-900/50 border border-gray-700 rounded p-3 text-xs text-gray-200 resize-none outline-none focus:border-blue-500 focus:bg-gray-900 transition-all placeholder:text-gray-700" placeholder="Type prompt here..." />

                                        <div className="grid grid-cols-3 gap-2">
                                            {['good', 'bad', 'accident'].map(q => {
                                                const isActive = subtasks.find(s => s.id === selectedSubtaskId)?.quality === q;
                                                const color = q === 'good' ? 'emerald' : q === 'bad' ? 'rose' : 'amber';
                                                return <button key={q} onClick={() => { const s = subtasks.find(x => x.id === selectedSubtaskId); if (s) setSubtasks(subtasks.map(x => x.id === s.id ? { ...x, quality: isActive ? null : q as any } : x)); }} className={`py-1.5 text-[10px] uppercase font-bold rounded border transition-all ${isActive ? `bg-${color}-500/10 text-${color}-400 border-${color}-500/50 shadow-[0_0_10px_rgba(0,0,0,0.3)]` : 'bg-gray-900 text-gray-600 border-gray-800 hover:border-gray-600 hover:text-gray-400'}`}>{q}</button>
                                            })}
                                        </div>

                                        <div className="pt-4 border-t border-gray-800/50 grid grid-cols-2 gap-2">
                                            <button onClick={() => handleMergeSubtask('prev')} className="px-2 py-1.5 bg-gray-800 hover:bg-blue-900/30 text-gray-400 hover:text-blue-300 text-[10px] font-bold uppercase rounded border border-gray-700 transition-colors">
                                                ← Merge Prev
                                            </button>
                                            <button onClick={() => handleMergeSubtask('next')} className="px-2 py-1.5 bg-gray-800 hover:bg-blue-900/30 text-gray-400 hover:text-blue-300 text-[10px] font-bold uppercase rounded border border-gray-700 transition-colors">
                                                Merge Next →
                                            </button>
                                        </div>
                                    </div>
                                ) : null}

                                {/* Contact Panel */}
                                {selectedContactId ? (
                                    <div className="space-y-4 animate-fade-in p-4 border border-purple-500/30 rounded-lg bg-purple-900/5 shadow-inner">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-bold text-purple-400 flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-purple-500"></span>
                                                CONTACT
                                            </span>
                                            <button onClick={() => setSelectedContactId(null)} className="text-gray-600 hover:text-white">✕</button>
                                        </div>
                                        <div className="text-[10px] text-gray-500 font-mono">
                                            ID: <span className="text-gray-300">{selectedContactId.split('-')[1]}</span>
                                        </div>
                                        <button onClick={handleDeleteContact} className="w-full py-2 bg-rose-950/30 hover:bg-rose-900/50 text-rose-500 hover:text-rose-400 border border-rose-900/50 rounded text-xs font-bold tracking-wide transition-all uppercase">
                                            Delete Contact
                                        </button>
                                    </div>
                                ) : !selectedSubtaskId && (
                                    <div className="flex flex-col items-center justify-center py-12 text-center opacity-40">
                                        <svg className="w-8 h-8 mb-2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" /></svg>
                                        <p className="text-xs font-medium text-gray-500">Select an item on the timeline<br />to edit properties</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* TIMELINE SECTION */}
                    <div className="h-[15%] w-full bg-gray-900 border-t border-gray-700 flex flex-col px-4 py-2 select-none shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.3)] z-20">
                        <div className="flex items-center gap-4 h-full">

                            {/* Time */}
                            <span className="text-xs font-mono text-blue-400 w-16 text-right tabular-nums">
                                {timestamps[0] ? formatTime(timestamps[currentFrameIndex] - timestamps[0]) : '00:00.000'}
                            </span>

                            {/* Timeline */}
                            <div
                                className="w-full h-full relative bg-gray-800 rounded-md border border-gray-700 overflow-hidden flex items-center"
                            >
                                <div
                                    ref={timelineInnerRef}
                                    className="h-full relative cursor-crosshair"
                                    style={{
                                        width: `100%`,
                                        minWidth: '100%'
                                    }}
                                    onMouseMove={handleTimelineMouseMove}
                                    onMouseLeave={handleTimelineMouseLeave}
                                >
                                    {/* Background Grid */}
                                    <div className="absolute inset-0 pointer-events-none" style={{ background: `repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(255,255,255,0.02) 10px, rgba(255,255,255,0.02) 20px)` }} />

                                    {/* Red Line Cursor (Current Frame) */}
                                    <div className="absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none z-30 shadow-[0_0_8px_rgba(239,68,68,0.8)]"
                                        style={{ left: `${(currentFrameIndex / (timestamps.length - 1 || 1)) * 100}%` }} />

                                    {/* White Line Cursor (Hovered Frame) */}
                                    {hoveredFrame.index !== null && (
                                        <div className="absolute top-0 bottom-0 w-px bg-white/70 pointer-events-none z-30"
                                            style={{ left: hoveredFrame.percent + '%' }} />
                                    )}

                                    {/* Track 1: Subtasks (Top Half) */}
                                    <div
                                        className="absolute top-0 h-1/2 w-full border-b border-gray-700/50 cursor-pointer overflow-hidden group/track1 hover:bg-white/5 transition-colors"
                                        onClick={handleTimelineClick}
                                        onContextMenu={handleSubtaskContextMenu}
                                    >
                                        <div className="absolute top-0 left-0 bg-blue-900/80 text-[9px] px-1.5 py-px text-blue-200 z-40 pointer-events-none rounded-br shadow-sm">Subtasks</div>
                                        {subtasks.map(anno => {
                                            const left = (anno.start / (timestamps.length - 1 || 1)) * 100;
                                            const width = ((anno.end - anno.start + 1) / (timestamps.length - 1 || 1)) * 100;
                                            let bgColor = 'bg-blue-500/30 border-blue-400/50';
                                            if (anno.quality === 'good') bgColor = 'bg-green-500/30 border-green-400/50';
                                            else if (anno.quality === 'bad') bgColor = 'bg-red-500/30 border-red-400/50';
                                            else if (anno.quality === 'accident') bgColor = 'bg-yellow-500/30 border-yellow-400/50';

                                            return (
                                                <div key={anno.id}
                                                    className={`absolute top-1 bottom-1 border-l border-r flex items-center justify-center rounded-sm backdrop-blur-[1px] ${bgColor} ${anno.id === selectedSubtaskId ? 'border-2 border-yellow-400 z-10' : ''}`}
                                                    style={{ left: `${left}%`, width: `${width}%` }}
                                                    title={`User: ${anno.username || 'Unknown'}\nPrompt: ${anno.prompt || 'None'}`}
                                                >
                                                    {anno.username && <span className="absolute top-0 right-0 text-[8px] bg-black/40 text-white px-1 rounded-bl">{anno.username.slice(0, 3)}</span>}
                                                    {anno.prompt && <span className="text-[10px] text-white shadow-black drop-shadow-md truncate px-1 pointer-events-none">{anno.prompt}</span>}
                                                </div>
                                            );
                                        })}
                                    </div>

                                    {/* Track 2: Contacts (Bottom Half) */}
                                    <div
                                        className="absolute bottom-0 h-1/2 w-full cursor-crosshair overflow-hidden group/track2 hover:bg-white/5 transition-colors"
                                        onClick={handleContactTrackClick}
                                        onContextMenu={handleContactTrackContextMenu}
                                    >
                                        <div className="absolute top-0 left-0 bg-purple-900/80 text-[9px] px-1.5 py-px text-blue-200 z-40 pointer-events-none rounded-br shadow-sm">Contacts</div>

                                        {/* Pending Creation Preview */}
                                        {pendingContactStart !== null && hoveredFrame.index !== null && (
                                            <div
                                                className="absolute top-1 bottom-1 bg-yellow-400/20 border-l border-r border-dashed border-yellow-400 pointer-events-none z-20"
                                                style={{
                                                    left: `${(Math.min(pendingContactStart, hoveredFrame.index) / (timestamps.length - 1 || 1)) * 100}%`,
                                                    width: `${(Math.max(MIN_CONTACT_FRAMES, Math.abs(hoveredFrame.index - pendingContactStart)) / (timestamps.length - 1 || 1)) * 100}%`
                                                }}
                                            />
                                        )}

                                        {contacts.map(contact => {
                                            const left = (contact.start / (timestamps.length - 1 || 1)) * 100;
                                            const width = ((contact.end - contact.start + 1) / (timestamps.length - 1 || 1)) * 100;
                                            const isSelected = contact.id === selectedContactId;

                                            return (
                                                <div
                                                    key={contact.id}
                                                    className={`absolute top-1.5 bottom-1.5 bg-purple-500/40 border border-purple-400/80 rounded-sm hover:bg-purple-500/60 group transition-all backdrop-blur-[1px] ${isSelected ? 'border-yellow-400 ring-1 ring-yellow-400 z-10' : ''}`}
                                                    style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleTimelineClick(e);
                                                    }}
                                                    title={`Contact created by: ${contact.username || 'Unknown'}`}
                                                >
                                                    {/* Drag Handles */}
                                                    <div className="absolute left-0 top-0 bottom-0 w-3 -ml-1.5 cursor-ew-resize hover:bg-white/30 z-20"
                                                        onMouseDown={(e) => handleMouseDownOnHandle(e, 'contact', contact.id, 'start')} />
                                                    <div className="absolute right-0 top-0 bottom-0 w-3 -mr-1.5 cursor-ew-resize hover:bg-white/30 z-20"
                                                        onMouseDown={(e) => handleMouseDownOnHandle(e, 'contact', contact.id, 'end')} />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            {/* Total Duration */}
                            <span className="text-xs font-mono text-gray-500 w-16 text-left tabular-nums">
                                {timestamps.length ? formatTime(timestamps[timestamps.length - 1] - timestamps[0]) : '00:00.000'}
                            </span>

                            {/* Playback Controls */}
                            {(() => {
                                const isAtEnd = timestamps.length > 0 && currentFrameIndex >= timestamps.length - 1;
                                return (
                                    <button
                                        onClick={() => {
                                            if (isAtEnd) {
                                                setCurrentFrameIndex(0);
                                                setIsPlaying(true);
                                            } else {
                                                togglePlayback();
                                            }
                                        }}
                                        className={`flex-shrink-0 w-12 h-10 flex items-center justify-center rounded-lg font-bold text-white shadow-lg transition-all active:scale-95 ${isPlaying ? 'bg-amber-600 hover:bg-amber-700' :
                                            isAtEnd ? 'bg-indigo-600 hover:bg-indigo-700' :
                                                'bg-emerald-600 hover:bg-emerald-700'
                                            }`}
                                        title={isPlaying ? "Pause" : isAtEnd ? "Replay" : "Play"}
                                    >
                                        {isPlaying ? (
                                            <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                                        ) : isAtEnd ? (
                                            <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 7.11-2.55 7.82-6.17h-2.06a5.999 5.999 0 01-5.76 4.17 6 6 0 010-12c1.66 0 3.14.69 4.22 1.78L13 13h7V6l-2.35 2.35z" /></svg>
                                        ) : (
                                            <svg className="w-5 h-5 fill-current ml-0.5" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                                        )}
                                    </button>
                                );
                            })()}
                        </div>
                    </div>
                </>
            )}

            <UrdfSettingsDialog
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                config={urdfConfig}
                onSave={setUrdfConfig}
                bagService={bagService}
            />
        </div>
    );
};

export default AnnotationPage;