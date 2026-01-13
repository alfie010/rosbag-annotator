import React, { useState, useEffect } from 'react';
import type { UrdfConfig } from '../urdf/UrdfViewer';
import type { BagService } from '../../services/BagService';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    config: UrdfConfig;
    onSave: (cfg: UrdfConfig) => void;
    bagService: BagService; // To show available topics
}

// --- PRESET 1: Piper ---
export const PIPER_CONFIG = {
    urdfUrl: `${import.meta.env.BASE_URL}urdf/piper_description/urdf/piper_description.URDF`,
    mappingCode: `
// Available: data['/topic/name']
// Return: { 'urdf_joint_name': angle_radians }

const left = data['/puppet/joint_left'];
const right = data['/puppet/joint_right'];
const map = {};

if (left) {
    const pos = left.position;
    map['piper1/joint1'] = pos[0];
    map['piper1/joint2'] = pos[1];
    map['piper1/joint3'] = pos[2];
    map['piper1/joint4'] = pos[3] * -1;
    map['piper1/joint5'] = pos[4];
    map['piper1/joint6'] = pos[5] * -1;
    map['piper1/joint7'] = pos[6] / 2; // Gripper
    map['piper1/joint8'] = -pos[6] / 2;
}

if (right) {
    const pos = right.position;
    map['piper2/joint1'] = pos[0];
    map['piper2/joint2'] = pos[1];
    map['piper2/joint3'] = pos[2];
    map['piper2/joint4'] = pos[3] * -1;
    map['piper2/joint5'] = pos[4];
    map['piper2/joint6'] = pos[5] * -1;
    map['piper2/joint7'] = pos[6] / 2;
    map['piper2/joint8'] = -pos[6] / 2;
}

return map;
`
};

// --- PRESET 2: RM75 (Dual) ---
export const RM75_CONFIG = {
    urdfUrl: `${import.meta.env.BASE_URL}urdf/rm75-urdf/urdf/rm_dual.urdf`,
    mappingCode: `
// Available: data['/topic/name']
// Return: { 'urdf_joint_name': angle_radians }

const map = {};

const left = data['/puppet/joint_left'];
const right = data['/puppet/joint_right'];

if (left && left.position) {
    const p = left.position;
    map['left_joint1'] = p[0]; map['left_joint2'] = p[1]; map['left_joint3'] = p[2];
    map['left_joint4'] = p[3]; map['left_joint5'] = p[4]; map['left_joint6'] = p[5]; map['left_joint7'] = p[6];
}

if (right && right.position) {
    const p = right.position;
    map['right_joint1'] = p[0]; map['right_joint2'] = p[1]; map['right_joint3'] = p[2];
    map['right_joint4'] = p[3]; map['right_joint5'] = p[4]; map['right_joint6'] = p[5]; map['right_joint7'] = p[6];
}

left_gripper = data['/puppet/left_gripper_state'].position[0] / 255 * 0.45;
right_gripper = data['/puppet/right_gripper_state'].position[0] / 255 * 0.45;
map['left_finger_joint'] = left_gripper;
map['right_finger_joint'] = right_gripper;

return map;
`
};

export const UrdfSettingsDialog: React.FC<Props> = ({ isOpen, onClose, config, onSave, bagService }) => {
    const [localConfig, setLocalConfig] = useState<UrdfConfig>(config);
    const [availableTopics, setAvailableTopics] = useState<string[]>([]);

    useEffect(() => {
        if (isOpen) {
            setLocalConfig(config);
            setAvailableTopics(Object.keys(bagService.topicMetadata).filter(t => 
                bagService.topicMetadata[t].msgType.includes('JointState')
            ));
        }
    }, [isOpen, config, bagService]);

    const loadPreset = (preset: typeof PIPER_CONFIG) => {
        setLocalConfig({
            urdfUrl: preset.urdfUrl,
            mappingCode: preset.mappingCode.trim()
        });
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
            {/* Main Modal: Fixed height (85vh) to allow editor to fill space */}
            <div className="bg-[#111] border border-gray-700 rounded-xl w-[900px] h-[85vh] flex flex-col shadow-2xl">
                
                {/* Header */}
                <div className="flex justify-between items-center p-4 border-b border-gray-800 shrink-0">
                    <h2 className="text-lg font-bold text-gray-200">URDF Configuration</h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-white">✕</button>
                </div>
                
                {/* Content Area: Flex column to manage layout */}
                <div className="flex-1 flex flex-col p-6 min-h-0">
                    
                    {/* Top Section: Fixed height settings */}
                    <div className="space-y-6 shrink-0">
                        {/* Path Input */}
                        <div>
                            <label className="block text-xs font-bold text-cyan-500 uppercase mb-2">URDF File Path (URL)</label>
                            <div className="flex gap-2">
                                <input 
                                    type="text" 
                                    value={localConfig.urdfUrl}
                                    onChange={e => setLocalConfig({...localConfig, urdfUrl: e.target.value})}
                                    className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300 focus:border-cyan-500 outline-none font-mono"
                                    placeholder="/urdf/robot/robot.urdf"
                                />
                            </div>
                            <p className="text-[10px] text-gray-500 mt-1">
                                Relative to the web root. Ensure meshes are also accessible via relative paths.
                            </p>
                        </div>

                        {/* Available Topics Hint */}
                        <div className="bg-gray-900/50 p-3 rounded border border-gray-800">
                            <span className="text-xs text-gray-400 font-bold block mb-1">Detected Joint Topics:</span>
                            <div className="flex flex-wrap gap-2">
                                {availableTopics.length > 0 ? availableTopics.map(t => (
                                    <span key={t} className="text-[10px] bg-gray-800 text-cyan-400 px-2 py-1 rounded font-mono border border-gray-700">{t}</span>
                                )) : <span className="text-[10px] text-gray-600">No JointStates detected in loaded bag</span>}
                            </div>
                        </div>
                    </div>

                    {/* Code Editor: Flex-1 to fill all remaining vertical space */}
                    <div className="flex-1 flex flex-col mt-6 min-h-0">
                        <label className="block text-xs font-bold text-cyan-500 uppercase mb-2">Joint Mapping Function</label>
                        <div className="flex-1 relative border border-gray-700 rounded overflow-hidden">
                             <textarea 
                                value={localConfig.mappingCode}
                                onChange={e => setLocalConfig({...localConfig, mappingCode: e.target.value})}
                                className="w-full h-full bg-[#0d0d0d] text-gray-300 p-4 font-mono text-xs outline-none resize-none leading-relaxed selection:bg-cyan-900"
                                spellCheck={false}
                            />
                        </div>
                        <p className="text-[10px] text-gray-500 mt-1 shrink-0">
                            Javascript body. Arguments: <code>data</code> (Record&lt;topic, msg&gt;). Return: Object mapping URDF joint names to radians.
                        </p>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-800 flex justify-between items-center shrink-0 bg-[#0e0e0e] rounded-b-xl">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider mr-2">Presets:</span>
                        <button 
                            onClick={() => loadPreset(PIPER_CONFIG)} 
                            className="px-3 py-1.5 rounded border border-gray-700 bg-gray-800 text-[10px] font-bold text-gray-300 hover:bg-gray-700 hover:border-gray-500 transition-all"
                        >
                            Piper
                        </button>
                        <button 
                            onClick={() => loadPreset(RM75_CONFIG)} 
                            className="px-3 py-1.5 rounded border border-gray-700 bg-gray-800 text-[10px] font-bold text-gray-300 hover:bg-gray-700 hover:border-gray-500 transition-all"
                        >
                            RM75 (Dual)
                        </button>
                    </div>

                    <div className="flex gap-3">
                        <button onClick={onClose} className="px-4 py-2 rounded text-xs font-bold text-gray-300 hover:bg-gray-800 transition-colors">Cancel</button>
                        <button onClick={() => { onSave(localConfig); onClose(); }} className="px-6 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold shadow-lg shadow-cyan-900/20 transition-colors">Save Configuration</button>
                    </div>
                </div>
            </div>
        </div>
    );
};