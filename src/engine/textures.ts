import * as THREE from "three";

/**
 * Textures without dropped frames. Images are decoded off the main thread (createImageBitmap) instead of inside
 * the WebGL upload, and big uploads wait in a queue that sends one to the GPU per frame slot, spaced apart, so
 * a burst of arrivals (the full-size maps, the Milky Way, the Moon, the clouds) never stalls the intro or a flight.
 */

let bitmaps: boolean | null = null;

/**
 * Loads an image as a texture, decoded off the main thread where the browser can. The bitmap is flipped while
 * decoding, so the texture keeps three.js's usual orientation (`flipY` does not apply to bitmaps).
 */
export async function loadTexture(url: string, options: { crossOrigin?: boolean } = {}): Promise<THREE.Texture> {
  bitmaps ??= typeof createImageBitmap === "function";
  if (bitmaps) {
    // Default mode and credentials, as the layout's preloads use (a mismatch downloads the file twice).
    const res = await fetch(url, options.crossOrigin ? { credentials: "omit" } : undefined);
    if (!res.ok) throw new Error(`texture ${res.status}`);
    const blob = await res.blob();
    let bitmap: ImageBitmap | null = null;
    try {
      // Data maps (water, night, clouds) must keep their raw values: no colour management while decoding.
      bitmap = await createImageBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    } catch {
      // Older Safari rejects the options bag: decode the classic way from now on.
      bitmaps = false;
    }
    if (bitmap) {
      const image = bitmap;
      const texture = new THREE.Texture(image as unknown as THREE.Texture["image"]);
      texture.flipY = false;
      texture.needsUpdate = true;
      texture.addEventListener("dispose", () => image.close());
      return texture;
    }
  }
  const loader = new THREE.TextureLoader();
  if (options.crossOrigin) loader.setCrossOrigin("anonymous");
  return loader.loadAsync(url);
}

/** Time after a 4k upload before the next: it takes a frame or two of GPU time; the frames between stay smooth. */
const GAP_MS = 220;

export class UploadQueue {
  private jobs: { texture: THREE.Texture; apply: () => void }[] = [];
  private next = 0;

  constructor(private renderer: THREE.WebGLRenderer) {}

  /** Holds every upload until `ms` from now (the intro plays undisturbed). */
  hold(ms: number) {
    this.next = Math.max(this.next, performance.now() + ms);
  }

  /** Queues a texture; `apply` puts it in use right after its upload. */
  push(texture: THREE.Texture, apply: () => void) {
    this.jobs.push({ texture, apply });
  }

  /** Call once per frame, before rendering: uploads at most one queued texture. */
  pump(now: number) {
    if (!this.jobs.length || now < this.next) return;
    const job = this.jobs.shift()!;
    this.renderer.initTexture(job.texture);
    job.apply();
    // The pause scales with the upload: a 1k planet map needs no more than the next frame.
    const image = job.texture.image as { width?: number; height?: number } | null;
    const pixels = (image?.width ?? 0) * (image?.height ?? 0);
    this.next = now + Math.max(16, GAP_MS * Math.min(1, pixels / (4096 * 2048)));
  }

  clear() {
    for (const job of this.jobs) job.texture.dispose();
    this.jobs = [];
  }
}
