declare module "cgview" {
  export interface CGViewFeature {
    name: string;
    start: number;
    stop: number;
    meta?: Record<string, unknown>;
    highlight(): void;
  }

  export interface CGViewEvent {
    bp?: number;
    elementType?: string;
    element?: CGViewFeature;
  }

  export class Viewer {
    constructor(containerId: string, options?: Record<string, unknown>);
    width: number;
    height: number;
    canvas: {
      clear(layer: string): void;
      drawElement(layer: string, start: number, stop: number, centerOffset: number, color?: string, width?: number, decoration?: string): void;
    };
    backbone: { adjustedCenterOffset: number; adjustedThickness: number };
    io: {
      getSVG(): string | undefined;
      downloadImage(width: number, height: number, filename?: string): void;
      download(data: string | Blob, filename: string, mediaType?: string): void;
    };
    addPlots(plots: Array<Record<string, unknown>>): unknown;
    addTracks(tracks: Array<Record<string, unknown>>): unknown;
    addCaptions(captions: Array<Record<string, unknown>>): unknown;
    draw(): void;
    drawFull(): void;
    resize(width?: number, height?: number, keepAspectRatio?: boolean, fast?: boolean): void;
    reset(duration?: number): void;
    features(): CGViewFeature[];
    on(event: string, callback: (event: CGViewEvent) => void): void;
    off(event: string): void;
    stopAnimate(): void;
  }
}

declare module "svgcanvas" {
  export class Context {
    constructor(width: number, height: number);
  }
}
