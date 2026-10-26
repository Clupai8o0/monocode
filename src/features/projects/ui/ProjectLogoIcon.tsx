import { Folder, type IconComponent } from "../../../shared/ui/icons";
import { useEffect, useState } from "react";
import { projectLogoBackground, projectLogoSrc } from "../model/projectLogos";
import {
  subscribeTabGroupLogos,
  tabGroupLogoDisplayRevision,
} from "../../workspace/model/tabGroups";

type Props = {
  path?: string | null;
  className?: string;
  imageClassName?: string;
  fallback?: IconComponent;
  fallbackStrokeWidth?: number;
  onError?: () => void;
};

export function ProjectLogoIcon({
  path,
  className = "size-3.5 shrink-0",
  imageClassName,
  fallback: Fallback = Folder,
  fallbackStrokeWidth = 1.5,
  onError,
}: Props) {
  const [revision, setRevision] = useState(tabGroupLogoDisplayRevision);

  useEffect(() => {
    const refresh = () => setRevision(tabGroupLogoDisplayRevision());
    return subscribeTabGroupLogos(refresh);
  }, []);

  const src = projectLogoSrc(path);
  if (src) {
    return (
      <img
        key={`${path ?? ""}:${revision}`}
        src={src}
        alt=""
        style={{ backgroundColor: projectLogoBackground(path) }}
        onError={onError}
        className={`rounded-sm object-contain ${className} ${imageClassName ?? ""}`}
      />
    );
  }
  return (
    <Fallback className={className} strokeWidth={fallbackStrokeWidth} />
  );
}
