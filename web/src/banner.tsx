import { useEffect, useRef, useState } from 'react';
import '../vendor/niltavi-ui/vendor/niltavi-banner/screenprint.js';

type BannerSettings = { seed?: string; wobble?: number; grain?: number; paper?: string };
type NiltaviBanner = { width: number; height: number; defaults: Required<BannerSettings>; drawPoster: (context: CanvasRenderingContext2D, settings?: BannerSettings) => void };

const banner = (globalThis as typeof globalThis & { NiltaviBanner: NiltaviBanner }).NiltaviBanner;

function resolveColor(host: Element, value: string) {
  const probe = document.createElement('span');
  probe.style.color = value;
  probe.style.display = 'none';
  host.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!pixel) return '';
  pixel.fillStyle = computed;
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a! / 255).toFixed(3)})`;
}

function useThemeVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion(v => v + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
  return version;
}

export function BannerScene() {
  const [seed] = useState(() => crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36));
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useThemeVersion();

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !context) return;
    const host = canvas.parentElement ?? canvas;
    const ink = resolveColor(host, 'var(--banner-paper)');
    banner.drawPoster(context, { seed, ...(ink ? { paper: ink } : {}) });
    const veil = resolveColor(host, 'var(--banner-veil)');
    if (veil && !veil.endsWith(', 0.000)')) {
      context.fillStyle = veil;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, [seed, theme]);

  return <canvas ref={ref} className="nt-banner" width={banner.width} height={banner.height} aria-hidden="true" />;
}
