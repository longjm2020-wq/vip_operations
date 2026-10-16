/** Canonical one-based row positions are computed before any personal query.
 * Both references use the transaction's workspace search_path. */
export const selectionRowNumberSource = " FROM style_selections s JOIN (SELECT id,row_number() OVER (ORDER BY sort_order ASC,id DESC) AS row_number FROM style_selections) row_positions ON row_positions.id=s.id";
export const selectionRowNumberColumn = "row_positions.row_number::int AS row_number";
export const selectionRowNumberRevision = "canonical-row-number-v1";
