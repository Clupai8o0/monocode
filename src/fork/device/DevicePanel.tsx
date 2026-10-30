import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Loader, X } from "../../shared/ui/icons";
import {
  devicePanelKind,
  devicePoint,
  deviceScreenshot,
  deviceSwipe,
  deviceTap,
  deviceType,
  isSwipe,
  listDevices,
  openDevicePanel,
  pickDevice,
  subscribeDevicePanel,
  type Device,
} from "./deviceModel";

const FRAME_GAP_MS = 700;
const LIST_MS = 10_000;

const PRESS =
  "transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

type Ripple = { id: number; x: number; y: number };

/** A phone's body around the live screen. Taps and drags go straight through. */
export function DeviceScreen({
  png,
  device,
  error,
  onTap,
  onSwipe,
}: {
  png: string | null;
  device: Device;
  error?: string;
  onTap: (point: { x: number; y: number }) => void;
  onSwipe: (from: { x: number; y: number }, to: { x: number; y: number }) => void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const start = useRef<{ clientX: number; clientY: number } | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const nextRipple = useRef(0);

  const toDevice = (clientX: number, clientY: number) => {
    const element = image.current;
    if (!element) return null;
    return devicePoint(clientX, clientY, element.getBoundingClientRect(), {
      width: element.naturalWidth,
      height: element.naturalHeight,
    });
  };
  const down = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    start.current = { clientX: event.clientX, clientY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const up = (event: ReactPointerEvent<HTMLImageElement>) => {
    const from = start.current;
    start.current = null;
    if (!from) return;
    const a = toDevice(from.clientX, from.clientY);
    const b = toDevice(event.clientX, event.clientY);
    if (!a) return;
    const moved = isSwipe(
      { x: from.clientX, y: from.clientY },
      { x: event.clientX, y: event.clientY },
    );
    if (moved && b) {
      onSwipe(a, b);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const id = nextRipple.current++;
    setRipples((current) => [
      ...current,
      { id, x: from.clientX - rect.left, y: from.clientY - rect.top },
    ]);
    window.setTimeout(
      () => setRipples((current) => current.filter((ripple) => ripple.id !== id)),
      320,
    );
    onTap(a);
  };

  const radius = device.kind === "ios" ? "rounded-[28px]" : "rounded-[20px]";
  return (
    <div
      data-fork-device-body={device.kind}
      className={`relative isolate mx-auto w-full max-w-[280px] bg-content/[0.1] p-[6px] shadow-[0_12px_32px_-16px_rgb(0_0_0/0.6)] ${radius}`}
    >
      <div
        className={`relative overflow-hidden bg-black ${device.kind === "ios" ? "rounded-[22px]" : "rounded-[14px]"}`}
      >
        {png ? (
          <img
            ref={image}
            src={`data:image/png;base64,${png}`}
            alt={`${device.name} screen`}
            draggable={false}
            onPointerDown={down}
            onPointerUp={up}
            onPointerCancel={() => {
              start.current = null;
            }}
            className="block w-full cursor-pointer select-none touch-none"
          />
        ) : (
          <div className="grid aspect-[9/19.5] place-items-center text-white/50">
            {error ? (
              <p className="px-4 text-center text-[12px] leading-relaxed">{error}</p>
            ) : (
              <Loader className="size-5 animate-spin" aria-hidden />
            )}
          </div>
        )}
        {ripples.map((ripple) => (
          <span
            key={ripple.id}
            aria-hidden
            className="pointer-events-none absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/40 motion-safe:animate-[fork-device-tap_300ms_cubic-bezier(0.23,1,0.32,1)_forwards]"
            style={{ left: ripple.x, top: ripple.y }}
          />
        ))}
      </div>
      <style>{`@keyframes fork-device-tap { from { opacity: 1; transform: translate(-50%, -50%) scale(0.5); } to { opacity: 0; transform: translate(-50%, -50%) scale(1.6); } }`}</style>
    </div>
  );
}

/** The panel's look, given its state, so the fixture can show each one. */
export function DevicePanelView({
  device,
  png,
  error,
  live,
  onTap,
  onSwipe,
  onType,
  onClose,
}: {
  device: Device | null;
  png: string | null;
  error?: string;
  live: boolean;
  onTap: (point: { x: number; y: number }) => void;
  onSwipe: (from: { x: number; y: number }, to: { x: number; y: number }) => void;
  onType: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <aside
      data-fork-device-panel
      aria-label="Device"
      className="flex w-[320px] shrink-0 flex-col gap-3 overflow-y-auto bg-content/[0.03] px-4 py-3 font-sans"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${live ? "bg-diff-add-fg" : "bg-content/25"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-content">
            {device?.name ?? "No device"}
          </p>
          <p className="text-[11px] text-content/50">
            {device ? (live ? "Live" : "Reconnecting") : "Nothing is running"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close the device panel"
          onClick={onClose}
          className={`grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content ${PRESS}`}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {device ? (
        <>
          <DeviceScreen
            png={png}
            device={device}
            error={error}
            onTap={onTap}
            onSwipe={onSwipe}
          />
          {error && png ? (
            <p role="alert" className="text-[12px] leading-relaxed text-diff-del-fg">
              {error}
            </p>
          ) : null}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!text) return;
              onType(text);
              setText("");
            }}
          >
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label="Type on the device"
              placeholder="Type on the device"
              className="h-8 min-w-0 flex-1 rounded-lg bg-content/[0.06] px-2.5 text-[12px] text-content outline-none placeholder:text-content/35 focus-visible:outline-2 focus-visible:outline-accent"
            />
            <button
              type="submit"
              disabled={!text}
              className={`h-8 shrink-0 rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
            >
              Send
            </button>
          </form>
        </>
      ) : (
        <div className="py-6 text-[12px] leading-relaxed text-content/55">
          <p>Start a shared device, and it shows up here:</p>
          <code className="mt-2 block rounded-lg bg-content/[0.06] px-2.5 py-2 font-mono text-[11px] text-content/80">
            stacks.py up ios "why"
            <br />
            stacks.py up android "why"
          </code>
          <p className="mt-2 text-content/45">
            Use the full Android image here: the lite one has no picture.
          </p>
        </div>
      )}
    </aside>
  );
}

/** Fork: a live device beside the focused session, opened from Stacks. */
export function DevicePanel() {
  const kind = useSyncExternalStore(subscribeDevicePanel, devicePanelKind);
  if (!kind) return null;
  // Keyed, so choosing the other platform shows it, not the one on screen.
  return <LiveDevicePanel key={kind} kind={kind} />;
}

function LiveDevicePanel({ kind }: { kind: Device["kind"] }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [png, setPng] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string>();
  const device = pickDevice(devices, kind, deviceId);
  const id = device?.id ?? null;

  useEffect(() => {
    const read = () => {
      listDevices()
        .then((next) => setDevices(next ?? []))
        .catch((failure) => setError(String(failure)));
    };
    read();
    const timer = window.setInterval(read, LIST_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => setDeviceId(id), [id]);

  // One screenshot at a time, with a pause between. A slow device just shows
  // fewer frames, and a hidden window takes none at all.
  useEffect(() => {
    setPng(null);
    setLive(false);
    if (!id) return;
    let stopped = false;
    let timer: number | undefined;
    const frame = async () => {
      if (!document.hidden) {
        try {
          const next = await deviceScreenshot(id);
          if (stopped) return;
          setPng(next);
          setLive(true);
          setError(undefined);
        } catch (failure) {
          if (stopped) return;
          setLive(false);
          setError(String(failure));
        }
      }
      if (!stopped) timer = window.setTimeout(() => void frame(), FRAME_GAP_MS);
    };
    void frame();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  const act = (work: Promise<void>) => {
    work.catch((failure) => setError(String(failure)));
  };
  return (
    <DevicePanelView
      device={device}
      png={png}
      error={error}
      live={live}
      onTap={({ x, y }) => id && act(deviceTap(id, x, y))}
      onSwipe={(from, to) => id && act(deviceSwipe(id, from, to))}
      onType={(text) => id && act(deviceType(id, text))}
      onClose={() => openDevicePanel(null)}
    />
  );
}
