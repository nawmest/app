import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL;

export interface FaceFrame {
  /** 478 landmarks in video pixels (x right, y down, z ~ depth in pixels). */
  points: Float32Array;
  /** Head rotation from the face transform (radians). */
  yaw: number;
  pitch: number;
  roll: number;
}

/** Loads MediaPipe Face Landmarker (self-hosted runtime and model). Prefers the GPU. */
export async function createFaceTracker(): Promise<FaceTracker> {
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe`);
  const make = (delegate: 'GPU' | 'CPU') =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${BASE}models/face_landmarker.task`, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFacialTransformationMatrixes: true,
    });
  // `?delegate=cpu` forces the CPU path (useful where the GPU is emulated, e.g. headless tests).
  const forceCpu = new URLSearchParams(location.search).get('delegate') === 'cpu';
  let lm: FaceLandmarker;
  try {
    lm = await make(forceCpu ? 'CPU' : 'GPU');
  } catch {
    lm = await make('CPU');
  }
  return new FaceTracker(lm);
}

export class FaceTracker {
  private lastTs = -1;
  constructor(private readonly lm: FaceLandmarker) {}

  /** Landmarks for the current video frame, or null when no face is visible. */
  detect(video: HTMLVideoElement, timestampMs: number): FaceFrame | null {
    // MediaPipe needs strictly increasing timestamps.
    const ts = Math.max(timestampMs, this.lastTs + 1);
    this.lastTs = ts;
    const res: FaceLandmarkerResult = this.lm.detectForVideo(video, ts);
    const lms = res.faceLandmarks?.[0];
    if (!lms) return null;
    const w = video.videoWidth;
    const h = video.videoHeight;
    const points = new Float32Array(lms.length * 3);
    lms.forEach((p, i) => {
      points[3 * i] = p.x * w;
      points[3 * i + 1] = p.y * h;
      points[3 * i + 2] = p.z * w;
    });
    let yaw = 0, pitch = 0, roll = 0;
    const m = res.facialTransformationMatrixes?.[0]?.data;
    if (m) {
      // Column-major 4x4 rotation part.
      yaw = Math.asin(Math.max(-1, Math.min(1, -m[2])));
      pitch = Math.atan2(m[6], m[10]);
      roll = Math.atan2(m[1], m[0]);
    }
    return { points, yaw, pitch, roll };
  }

  close(): void {
    this.lm.close();
  }
}

export const TESSELATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
export const FACE_OVAL = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL;
