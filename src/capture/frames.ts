/** A single captured frame on disk, timestamped relative to capture start. */
export interface CapturedFrame {
  /** Filename within the frames dir. */
  file: string;
  /** Capture time in ms, relative to recording start. */
  t: number;
}
