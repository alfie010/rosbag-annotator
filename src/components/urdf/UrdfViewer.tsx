import { useState, useRef, useEffect, useCallback } from 'react';
import URDFManipulator from './UrdfManipulator';
import type { URDFRobot } from './URDFClasses';

interface UrdfViewerProps {
    jointState: number[] | null;
}

const UrdfViewer = ({ jointState }: UrdfViewerProps) => {
    const modelRef = useRef<URDFRobot | null>(null);
    const [isModelReady, setIsModelReady] = useState(false);

    const handleModelReady = useCallback(() => {
        setIsModelReady(true);
    }, []);

    useEffect(() => {
        if (modelRef.current && jointState && isModelReady) {
            try {
                const convertGripper = (value: number) => [value / 2, -value / 2];
                const jointValues = [
                    jointState[0], jointState[1], jointState[2],
                    jointState[3] * -1, jointState[4], jointState[5] * -1,
                    ...convertGripper(jointState[6]),
                    jointState[7], jointState[8], jointState[9],
                    jointState[10] * -1, jointState[11], jointState[12] * -1,
                    ...convertGripper(jointState[13])
                ];
                const names = ['piper1/joint1', 'piper1/joint2', 'piper1/joint3',
                    'piper1/joint4', 'piper1/joint5', 'piper1/joint6', 'piper1/joint7', 'piper1/joint8',
                    'piper2/joint1', 'piper2/joint2', 'piper2/joint3',
                    'piper2/joint4', 'piper2/joint5', 'piper2/joint6', 'piper2/joint7', 'piper2/joint8'];
                const jointValuesObj = Object.fromEntries(
                    names.map((name, index) => [name, jointValues[index]])
                );
                Object.entries(modelRef.current.joints).forEach(([jointName, joint]) => {
                    if (jointName in jointValuesObj) {
                        joint.setJointValue(jointValuesObj[jointName]);
                    }
                });
            } catch (error) {
                console.error("Failed to set joint values:", error);
            }
        }
    }, [jointState, isModelReady]);

    return (
        <div id="urdfContainer" className="w-full h-full rounded-lg shadow-md border border-gray-200 bg-gray-200">
            <URDFManipulator modelRef={modelRef} onReady={handleModelReady}/>
        </div>
    );
};

export default UrdfViewer;
