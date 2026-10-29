import { Block, Segmented, Toggle } from "../lab/labUi";
import { IDLE_MINUTE_CHOICES, type IdleMinutes } from "./memoryModel";
import { setMemorySettings, useMemorySettings } from "./memoryStore";

/**
 * Fork: Settings > Memory. One switch for auto-park (off by default) and how
 * long a session must sit idle before auto-park may pick it.
 */
export function MemorySettings() {
  const { autoPark, idleMinutes } = useMemorySettings();
  return (
    <div className="flex flex-col gap-6">
      <Block title="Auto-park idle sessions when memory is tight">
        <div className="flex items-start gap-4">
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-content/55">
            When this Mac has been short of memory for a minute, MonoCode stops
            the agents of the sessions that have sat idle longest and hold the
            most memory. Their conversations stay; your next message picks each
            one up again. Sessions that are working, waiting for you, or on
            screen are never touched.
          </p>
          <Toggle
            label="Auto-park idle sessions when memory is tight"
            on={autoPark}
            onChange={(on) => setMemorySettings({ autoPark: on })}
          />
        </div>
      </Block>
      <Block title="Idle for at least">
        <div className="flex flex-col gap-2 text-[12px]">
          <Segmented<string>
            label="Idle threshold"
            options={IDLE_MINUTE_CHOICES.map((minutes) => ({
              value: String(minutes),
              label: `${minutes} min`,
            }))}
            value={String(idleMinutes)}
            onChange={(value) =>
              setMemorySettings({ idleMinutes: Number(value) as IdleMinutes })
            }
          />
          <p className="leading-relaxed text-content/50">
            Auto-park only picks sessions idle this long. You can always park a
            session yourself from the Memory chip in the footer.
          </p>
        </div>
      </Block>
    </div>
  );
}
