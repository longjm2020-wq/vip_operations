import { db, Row } from "../../../../../packages/database/src/index.js";
import {
  compassDimensions,
  shiftCompassDate,
  shanghaiDate,
} from "../../../../../packages/contracts/src/compass-analytics.js";
import { compassSources, dashboard } from "./service.js";

export type CompassBundle = {
  date: string;
  snapshots: Row[];
  windows: Row[];
  ids: string[];
  summary: Row[];
};
export async function collectCompassBundle(
  requestedDate?: string,
): Promise<CompassBundle | null> {
  return db.$transaction(
    async (tx) => {
      const sources = await compassSources(tx),
        date = requestedDate || sources[0]?.end_date;
      if (
        !date ||
        date > shiftCompassDate(shanghaiDate(), -1) ||
        sources.length !== 3 ||
        sources.some(
          (s) =>
            s.end_date !== date || s.start_date > shiftCompassDate(date, -29),
        )
      )
        return null;
      const snapshots: Row[] = [];
      for (const dimension of compassDimensions)
        snapshots.push(
          await dashboard(
            { dimension, days: 7, endDate: date, pageSize: 1 },
            tx,
          ),
        );
      const windows: Row[] = [];
      for (const days of [1, 3, 7, 15, 30])
        windows.push(
          days === 7
            ? snapshots[0]
            : await dashboard(
                { dimension: "style", days, endDate: date, pageSize: 1 },
                tx,
              ),
        );
      return {
        date,
        snapshots,
        windows,
        ids: sources.map((s) => String(s.id)),
        summary: snapshots.map((s) => ({
          dimension: s.dimension,
          summary: s.summary,
        })),
      };
    },
    { isolationLevel: "RepeatableRead", timeout: 30000 },
  );
}
