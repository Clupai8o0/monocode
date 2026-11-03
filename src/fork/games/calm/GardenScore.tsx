import { useEffect, useState } from "react";
import { GARDEN_EVENT, loadGarden, type GardenState } from "./garden";

export function GardenScore()
{
  const [state, setState] = useState<GardenState>(() => loadGarden());
  useEffect(() => {
    const onChange = () => setState(loadGarden());
    window.addEventListener(GARDEN_EVENT, onChange);
    return () => window.removeEventListener(GARDEN_EVENT, onChange);
  }, []);
  return (
    <>
      <span data-fork-games-score={state.petals}>petals {state.petals}</span>
      <span className="text-content/35">blooms {state.blooms}</span>
    </>
  );
}
