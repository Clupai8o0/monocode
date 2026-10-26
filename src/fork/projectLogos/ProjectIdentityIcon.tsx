import { useState, useSyncExternalStore } from "react";
import { projectLogoSrc } from "../../features/projects/model/projectLogos";
import { ProjectLogoIcon } from "../../features/projects/ui/ProjectLogoIcon";
import { ProjectMascot } from "../../features/projects/ui/ProjectMascot";
import "./projectIdentity.css";

const visibilityListeners = new Set<() => void>();
function visibilityChanged() {
  for (const listener of visibilityListeners) {
    listener();
  }
}
function subscribeVisibility(listener: () => void) {
  visibilityListeners.add(listener);
  if (visibilityListeners.size === 1) {
    document.addEventListener("visibilitychange", visibilityChanged);
  }
  return () => {
    visibilityListeners.delete(listener);
    if (!visibilityListeners.size) {
      document.removeEventListener("visibilitychange", visibilityChanged);
    }
  };
}
const pageVisible = () => !document.hidden;

/** CSS does the work; one shared visibility listener pauses every hidden icon. */
export function ProjectIdentityIcon({
  logoPath,
  project,
  color,
  mascot,
  busy,
  className,
  mascotClassName,
}: {
  logoPath: string;
  project: string;
  color: string;
  mascot: string | null;
  busy: boolean;
  className: string;
  mascotClassName: string;
}) {
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = projectLogoSrc(logoPath);
  const failed = source === failedSource;
  return (
    <span
      aria-hidden
      data-project-identity=""
      data-working={busy || undefined}
      data-logo-failed={failed || undefined}
      data-document-hidden={!visible || undefined}
      className={`${className} project-identity grid shrink-0 place-items-center rounded-[5px]`}
    >
      {!failed ? (
        <span className="project-identity-logo col-start-1 row-start-1 size-full">
          <ProjectLogoIcon
            path={logoPath}
            className="size-full rounded-[5px]"
            onError={() => setFailedSource(source)}
          />
        </span>
      ) : null}
      {busy || failed ? (
        <span className="project-identity-mascot col-start-1 row-start-1 grid size-full place-items-center rounded-[5px] bg-content/8">
          <ProjectMascot
            project={project}
            color={color}
            name={mascot}
            className={mascotClassName}
            active={busy}
          />
        </span>
      ) : null}
    </span>
  );
}
