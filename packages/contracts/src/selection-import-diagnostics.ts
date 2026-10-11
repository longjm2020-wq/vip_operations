/** Row and image indices refer to the submitted import arrays, not worksheet rows. */
export type SelectionImportImageColorDiagnostic = {
  kind: "SELECTION_IMPORT_IMAGE_COLOR";
  rowIndex: number;
  xutiStyleNo: string;
  /** Omitted when retained images are unreadable; their order/count is private too. */
  imageIndex?: number;
  imageSource: "import" | "existing";
  colorSource: "import" | "existing";
  imageColor?: string;
  allowedColors?: string[];
};
