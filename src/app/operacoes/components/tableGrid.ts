import type { PickupEvent } from "../types";

const GRID_CONFIG = {
  all: {
    header: "grid-cols-[minmax(230px,1.6fr)_110px_120px_105px_90px_100px_100px_minmax(170px,1fr)]",
    row: "lg:grid-cols-[minmax(230px,1.6fr)_110px_120px_105px_90px_100px_100px_minmax(170px,1fr)]",
    minWidth: "",
  },
  noShirt: {
    header: "grid-cols-[minmax(250px,1.8fr)_115px_105px_90px_100px_100px_minmax(180px,1fr)]",
    row: "lg:grid-cols-[minmax(250px,1.8fr)_115px_105px_90px_100px_100px_minmax(180px,1fr)]",
    minWidth: "",
  },
  noKit: {
    header: "grid-cols-[minmax(240px,1.75fr)_110px_120px_105px_100px_100px_minmax(175px,1fr)]",
    row: "lg:grid-cols-[minmax(240px,1.75fr)_110px_120px_105px_100px_100px_minmax(175px,1fr)]",
    minWidth: "",
  },
  noWristband: {
    header: "grid-cols-[minmax(240px,1.7fr)_110px_120px_105px_90px_100px_minmax(180px,1fr)]",
    row: "lg:grid-cols-[minmax(240px,1.7fr)_110px_120px_105px_90px_100px_minmax(180px,1fr)]",
    minWidth: "",
  },
  noShirtNoKit: {
    header: "grid-cols-[minmax(260px,1.95fr)_120px_110px_100px_100px_minmax(190px,1fr)]",
    row: "lg:grid-cols-[minmax(260px,1.95fr)_120px_110px_100px_100px_minmax(190px,1fr)]",
    minWidth: "",
  },
  noShirtNoWristband: {
    header: "grid-cols-[minmax(260px,1.95fr)_120px_110px_95px_100px_minmax(200px,1fr)]",
    row: "lg:grid-cols-[minmax(260px,1.95fr)_120px_110px_95px_100px_minmax(200px,1fr)]",
    minWidth: "",
  },
  noKitNoWristband: {
    header: "grid-cols-[minmax(250px,1.85fr)_120px_125px_110px_100px_minmax(195px,1fr)]",
    row: "lg:grid-cols-[minmax(250px,1.85fr)_120px_125px_110px_100px_minmax(195px,1fr)]",
    minWidth: "",
  },
  minimal: {
    header: "grid-cols-[minmax(270px,2fr)_125px_115px_105px_minmax(210px,1fr)]",
    row: "lg:grid-cols-[minmax(270px,2fr)_125px_115px_105px_minmax(210px,1fr)]",
    minWidth: "",
  },
};

export function getOperationsGridConfig(selectedEvent: PickupEvent | null) {
  const hasShirt = Boolean(selectedEvent?.has_shirt);
  const hasKit = Boolean(selectedEvent?.has_kit);
  const hasWristband = Boolean(selectedEvent?.wristband_enabled);

  if (hasShirt && hasKit && hasWristband) return GRID_CONFIG.all;
  if (!hasShirt && hasKit && hasWristband) return GRID_CONFIG.noShirt;
  if (hasShirt && !hasKit && hasWristband) return GRID_CONFIG.noKit;
  if (hasShirt && hasKit && !hasWristband) return GRID_CONFIG.noWristband;
  if (!hasShirt && !hasKit && hasWristband) return GRID_CONFIG.noShirtNoKit;
  if (!hasShirt && hasKit && !hasWristband) return GRID_CONFIG.noShirtNoWristband;
  if (hasShirt && !hasKit && !hasWristband) return GRID_CONFIG.noKitNoWristband;
  return GRID_CONFIG.minimal;
}
