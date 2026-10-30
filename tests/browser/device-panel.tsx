import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DevicePanelView } from "../../src/fork/device/DevicePanel";
import type { Device } from "../../src/fork/device/deviceModel";
import "../../src/styles/index.css";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

// Stands in for a device's screenshot: a phone app, at a real pixel size.
function fakeScreen() {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 2340;
  const draw = canvas.getContext("2d")!;
  draw.fillStyle = "#101418";
  draw.fillRect(0, 0, 1080, 2340);
  draw.fillStyle = "#e6e8eb";
  draw.font = "600 64px sans-serif";
  draw.fillText("Sessions", 64, 220);
  ["Fix the login redirect", "Add the cost view", "Reconcile the export"].forEach(
    (title, row) => {
      draw.fillStyle = "#1c2228";
      draw.beginPath();
      draw.roundRect(48, 300 + row * 220, 984, 190, 36);
      draw.fill();
      draw.fillStyle = "#e6e8eb";
      draw.font = "48px sans-serif";
      draw.fillText(title, 96, 400 + row * 220);
      draw.fillStyle = "#6f7a85";
      draw.font = "36px sans-serif";
      draw.fillText("Working · 3m", 96, 455 + row * 220);
    },
  );
  return canvas.toDataURL("image/png").split(",")[1];
}

const ios: Device = { id: "ios:1", kind: "ios", name: "iPhone 17 Pro" };
const android: Device = { id: "android:emulator-5554", kind: "android", name: "emulator-5554" };

function Panel({ device, shot }: { device: Device | null; shot: string }) {
  const [events, setEvents] = useState<string[]>([]);
  const note = (text: string) => setEvents((current) => [...current, text]);
  return (
    <div className="flex flex-col gap-2" data-shot={device?.kind ?? "none"}>
      <div className="flex h-[780px]">
        <DevicePanelView
          device={device}
          png={device ? shot : null}
          live={!!device}
          onTap={({ x, y }) => note(`tap ${Math.round(x)} ${Math.round(y)}`)}
          onSwipe={() => note("swipe")}
          onType={(text) => note(`type ${text}`)}
          onClose={() => note("close")}
        />
      </div>
      <output data-events className="text-[11px] text-content/60">
        {events.join(", ")}
      </output>
    </div>
  );
}

function Fixture() {
  const shot = useMemo(fakeScreen, []);
  return (
    <div className="flex items-start gap-4 p-4">
      <Panel device={ios} shot={shot} />
      <Panel device={android} shot={shot} />
      <Panel device={null} shot={shot} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
