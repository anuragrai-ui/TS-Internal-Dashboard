"use client";

import { useEffect, useState } from "react";

interface RefreshCountdownProps {
  nextSyncIso: string;
}

function formatRemainingSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function RefreshCountdown({
  nextSyncIso,
}: RefreshCountdownProps): React.ReactElement {
  const [remaining, setRemaining] = useState("--:--");

  useEffect(() => {
    if (!nextSyncIso) {
      setRemaining("--:--");
      return undefined;
    }

    const updateCountdown = (): void => {
      const refreshTime = new Date(nextSyncIso);
      const diff = Math.floor((refreshTime.getTime() - Date.now()) / 1000);

      if (diff <= 0) {
        window.location.reload();
        return;
      }

      setRemaining(formatRemainingSeconds(diff));
    };

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [nextSyncIso]);

  return <span id="countdown">{remaining}</span>;
}
