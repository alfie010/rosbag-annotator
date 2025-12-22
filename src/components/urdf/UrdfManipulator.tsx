import { useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import URDFLoader from './URDFLoader';
import type { URDFRobot } from './URDFClasses';

function URDFModel({ path, modelRef, onReady }: {
  path: string;
  modelRef: React.RefObject<URDFRobot | null>;
  onReady: () => void;
}) {
  const { scene } = useThree();

  useEffect(() => {
    const loader = new URDFLoader();
    loader.parseCollision = true;

    let urdfModel: URDFRobot | null = null;

    loader.load(path, (urdf) => {
      urdfModel = urdf;
      urdf.position.set(0, -0.2, 0);
      urdf.rotation.set(-Math.PI / 2, 0, 0);
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
      if (urdfModel) {
        scene.remove(urdfModel);
      }
      modelRef.current = null;
    };

  }, [path, scene, modelRef, onReady]);

  return null;
}

export default function URDFManipulator({ modelRef, onReady }: {
  modelRef: React.RefObject<URDFRobot | null>;
  onReady: () => void;
}) {
  return (
    <Canvas
      shadows
      camera={{ position: [-1.465, 0.776, -0.002], quaternion: [-0.124, -0.701, -0.126, 0.690], fov: 30 }}
      style={{ width: '100%', height: '100%' }}
    >
      <ambientLight intensity={0.15} />
      {/* Key Light */}
      <directionalLight
        position={[5, 5, 5]}
        intensity={1.2}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      {/* Fill Light */}
      <directionalLight
        position={[-5, 3, 3]}
        intensity={0.4}
      />
      {/* Rim Light */}
      <directionalLight
        position={[0, 3, -5]}
        intensity={0.8}
      />

      <URDFModel
        path={`${import.meta.env.BASE_URL}urdf/piper_description/urdf/piper_description.URDF`}
        modelRef={modelRef}
        onReady={onReady}
      />

      <OrbitControls enableDamping dampingFactor={0.05} />
    </Canvas>
  );
}
