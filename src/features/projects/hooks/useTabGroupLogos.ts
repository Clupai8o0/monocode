import { useEffect, useState } from "react";
import {
  loadTabGroupLogos,
  subscribeTabGroupLogos,
} from "../../workspace/model/tabGroups";

export function useTabGroupLogos(): Record<string, string> {
  const [logos, setLogos] = useState(loadTabGroupLogos);
  useEffect(() => {
    const refresh = () => setLogos(loadTabGroupLogos());
    return subscribeTabGroupLogos(refresh);
  }, []);
  return logos;
}
