import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import * as THREE from 'three';
import URDFLoader from './URDFLoader'; // Ensure this handles package:// correctly or use a patched version
import type { URDFRobot } from './URDFClasses';
import type { JointStateMsg } from '../../services/BagService';

// --- Types ---
export interface UrdfConfig {
    urdfUrl: string;
    // A function body string: (jointData: Record<string, JointStateMsg>) => Record<string, number>
    // Returns { 'joint_name_in_urdf': angle_in_radians }
    mappingCode: string; 
}

interface URDFModelProps {
    path: string;
    modelRef: React.RefObject<URDFRobot | null>;
    onReady: () => void;
}

function URDFModel({ path, modelRef, onReady }: URDFModelProps) {
    const { scene } = useThree();

    useEffect(() => {
        const loader = new URDFLoader();
        loader.parseCollision = true;
        loader.parseVisual = true;
        
        // Optional: specific package path handling if your URDFs use package://
        // loader.packages = { 'piper_description': '/urdf/piper_description' };

        let urdfModel: URDFRobot | null = null;

        loader.load(path, (urdf) => {
            urdfModel = urdf;
            // Default orientation adjustment (can be exposed to settings later)
            urdf.rotation.x = -Math.PI / 2;
            urdf.position.y = -0.2;
            
            urdf.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                    (child as THREE.Mesh).castShadow = true;
                    (child as THREE.Mesh).receiveShadow = true;
                }
            });
            scene.add(urdf);
            modelRef.current = urdf;
            onReady();
        });

        return () => {
            if (urdfModel) scene.remove(urdfModel);
            modelRef.current = null;
        };
    }, [path, scene, modelRef, onReady]);

    return null;
}

interface UrdfViewerProps {
    jointData: Record<string, JointStateMsg> | null;
    config: UrdfConfig;
}

const UrdfViewer = ({ jointData, config }: UrdfViewerProps) => {
    const modelRef = useRef<URDFRobot | null>(null);
    const [isModelReady, setIsModelReady] = useState(false);

    // Create the processor function from the string
    const processJoints = useMemo(() => {
        try {
            // Safety: This is running local user code.
            // Function signature: (data) => { return { ... } }
            return new Function('data', config.mappingCode);
        } catch (e) {
            console.error("Error parsing joint mapping code:", e);
            return null;
        }
    }, [config.mappingCode]);

    const handleModelReady = useCallback(() => setIsModelReady(true), []);

    useEffect(() => {
        if (modelRef.current && jointData && isModelReady && processJoints) {
            try {
                // 1. Execute User Code
                const targetJointValues = processJoints(jointData) as Record<string, number>;
                
                // 2. Apply to URDF
                if (targetJointValues) {
                    Object.entries(modelRef.current.joints).forEach(([name, joint]) => {
                        if (targetJointValues[name] !== undefined) {
                            joint.setJointValue(targetJointValues[name]);
                        }
                    });
                }
            } catch (error) {
                // Debounce logging in real app
                console.error("Failed to update joints:", error); 
            }
        }
    }, [jointData, isModelReady, processJoints]);

    return (
        <div id="urdfContainer" className="w-full h-full rounded-lg shadow-inner bg-gradient-to-b from-gray-900 to-black overflow-hidden relative">
            <Canvas shadows camera={{ position: [1, 1, 1], fov: 45 }}>
                <ambientLight intensity={0.5} />
                <directionalLight position={[5, 10, 5]} castShadow intensity={1} />
                <Grid infiniteGrid fadeDistance={20} sectionColor="#444" cellColor="#222"/>
                
                <URDFModel 
                    path={config.urdfUrl} 
                    modelRef={modelRef} 
                    onReady={handleModelReady} 
                />
                <OrbitControls makeDefault />
            </Canvas>
        </div>
    );
};

export default UrdfViewer;