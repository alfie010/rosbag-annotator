import cvModule from '@techstark/opencv-js';

export class ImageProcessor {
    private cv: any = null;

    async init(): Promise<void> {
        if (this.cv) return;

        if (cvModule instanceof Promise) {
            this.cv = await cvModule;
        } else {
            if ((cvModule as any).getBuildInformation) {
                this.cv = cvModule;
            } else {
                await new Promise<void>((resolve) => {
                    (cvModule as any).onRuntimeInitialized = () => resolve();
                });
                this.cv = cvModule;
            }
        }
        console.log("✅ OpenCV.js is ready!", this.cv.getBuildInformation ? this.cv.getBuildInformation() : '');
    }

    public processMessage(msg: any): string | null {
        if (!this.cv) {
            console.warn("OpenCV is not initialized. Call init() first.");
            return null;
        }

        const { encoding, width, height, data } = msg;
        const rawData = data instanceof Uint8Array ? data : new Uint8Array(data);

        try {
            if (encoding === '16UC1') {
                return this.processDepthImage(rawData, width, height);
            } else if (encoding === 'bgr8') {
                return this.processBGR8Image(rawData, width, height);
            } else if (encoding === 'rgb8') {
                return this.processRGB8Image(rawData, width, height);
            } else if (encoding === 'mono8') {
                return this.processMono8Image(rawData, width, height);
            }
            return null;
        } catch (e) {
            console.error("OpenCV Process Error:", e);
            return null;
        }
    }

    private processDepthImage(data: Uint8Array, width: number, height: number): string {
        // 使用 this.cv 替代全局 cv
        let mat16 = new this.cv.Mat(height, width, this.cv.CV_16UC1);
        let matF32 = new this.cv.Mat();
        let normalized = new this.cv.Mat();
        let colorMat = new this.cv.Mat();
        let rgbMat = new this.cv.Mat();

        try {
            mat16.data.set(data);

            mat16.convertTo(matF32, this.cv.CV_32F);

            // 类型断言修复 TS 报错
            const result = (this.cv as any).minMaxLoc(matF32);
            
            const range = Math.max(result.maxVal - result.minVal, 1e-6);
            const alpha = 255.0 / range;
            const beta = -result.minVal * alpha;
            
            matF32.convertTo(normalized, this.cv.CV_8U, alpha, beta);

            // COLORMAP_TURBO 通常是 20
            this.cv.applyColorMap(normalized, colorMat, this.cv.COLORMAP_TURBO);
            this.cv.cvtColor(colorMat, rgbMat, this.cv.COLOR_BGR2RGBA);

            return this.matToCanvasUrl(rgbMat);
        } finally {
            mat16.delete(); matF32.delete(); normalized.delete(); colorMat.delete(); rgbMat.delete();
        }
    }

    private processBGR8Image(data: Uint8Array, width: number, height: number): string {
        let src = new this.cv.Mat(height, width, this.cv.CV_8UC3);
        let dst = new this.cv.Mat();
        try {
            src.data.set(data);
            this.cv.cvtColor(src, dst, this.cv.COLOR_BGR2RGBA);
            return this.matToCanvasUrl(dst);
        } finally {
            src.delete(); dst.delete();
        }
    }

    private processRGB8Image(data: Uint8Array, width: number, height: number): string {
        let src = new this.cv.Mat(height, width, this.cv.CV_8UC3);
        let dst = new this.cv.Mat();
        try {
            src.data.set(data);
            this.cv.cvtColor(src, dst, this.cv.COLOR_RGB2RGBA);
            return this.matToCanvasUrl(dst);
        } finally {
            src.delete(); dst.delete();
        }
    }

    private processMono8Image(data: Uint8Array, width: number, height: number): string {
        let src = new this.cv.Mat(height, width, this.cv.CV_8UC1);
        let dst = new this.cv.Mat();
        try {
            src.data.set(data);
            this.cv.cvtColor(src, dst, this.cv.COLOR_GRAY2RGBA);
            return this.matToCanvasUrl(dst);
        } finally {
            src.delete(); dst.delete();
        }
    }

    private matToCanvasUrl(mat: any): string {
        const canvas = document.createElement('canvas');
        canvas.width = mat.cols;
        canvas.height = mat.rows;
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';
        const imgData = new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows);
        ctx.putImageData(imgData, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.8);
    }
}