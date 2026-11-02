import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
} from "docx";
import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import type { z } from "zod";
import { documentJobSchema } from "../../../../../packages/contracts/src/assistant-agent.js";
const PptxGenJS = createRequire(import.meta.url)(
  "pptxgenjs",
) as typeof import("pptxgenjs").default;

export async function createAgentDocument(
  input: z.infer<typeof documentJobSchema>,
) {
  const data = documentJobSchema.parse(input);
  const flat = () =>
    data.sections
      .map((s) =>
        [
          s.heading,
          s.text,
          ...s.rows.map((row) => row.map((v) => v ?? "").join("\t")),
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
  if (data.format === "docx") {
    const paragraphs: (Paragraph | Table)[] = [
      new Paragraph({ text: data.title, heading: HeadingLevel.TITLE }),
    ];
    for (const section of data.sections) {
      if (section.heading)
        paragraphs.push(
          new Paragraph({
            text: section.heading,
            heading: HeadingLevel.HEADING_1,
          }),
        );
      for (const line of section.text.split("\n"))
        paragraphs.push(
          new Paragraph({
            children: [new TextRun(line)],
            spacing: { after: 140 },
          }),
        );
      if (section.rows.length)
        paragraphs.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: section.rows.map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (v) =>
                      new TableCell({
                        children: [new Paragraph(String(v ?? ""))],
                      }),
                  ),
                }),
            ),
          }),
        );
    }
    const doc = new Document({
      creator: "XUTI 小序",
      title: data.title,
      styles: {
        default: { document: { run: { font: "Microsoft YaHei", size: 22 } } },
      },
      sections: [{ children: paragraphs }],
    });
    return {
      content: await Packer.toBuffer(doc),
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
  if (data.format === "xlsx") {
    const book = new ExcelJS.Workbook();
    book.creator = "XUTI 小序";
    data.sections.forEach((section, i) => {
      const name =
        (section.heading || `工作表${i + 1}`)
          .replace(/[\\/*?:[\]]/g, " ")
          .slice(0, 24) + ` ${i + 1}`;
      const sheet = book.addWorksheet(name);
      if (section.text) {
        sheet.addRow([section.text]);
        sheet.getRow(1).alignment = { wrapText: true };
      }
      for (const row of section.rows) sheet.addRow(row);
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      sheet.columns.forEach((col) => {
        col.width = 24;
      });
      sheet.getRow(section.text ? 2 : 1).font = {
        bold: true,
        color: { argb: "FF435EE5" },
      };
      // All values are literal cells; supplied strings are never executed as formulas.
    });
    return {
      content: Buffer.from(await book.xlsx.writeBuffer()),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  if (data.format === "pptx") {
    const slides = new PptxGenJS();
    slides.layout = "LAYOUT_WIDE";
    slides.author = "XUTI 小序";
    slides.subject = data.title;
    slides.title = data.title;
    for (const section of data.sections) {
      const pages = section.text.match(/[\s\S]{1,700}/g) || [""];
      for (let p = 0; p < pages.length; p++) {
        const slide = slides.addSlide();
        slide.background = { color: "F6F7FC" };
        slide.addText(section.heading || data.title, {
          x: 0.65,
          y: 0.45,
          w: 12,
          h: 0.7,
          fontFace: "Microsoft YaHei",
          fontSize: 28,
          bold: true,
          color: "435EE5",
          breakLine: false,
        });
        slide.addText(pages[p], {
          x: 0.7,
          y: 1.4,
          w: 11.9,
          h: 4.9,
          fontFace: "Microsoft YaHei",
          fontSize: 20,
          color: "25304A",
          valign: "top",
          fit: "shrink",
          breakLine: false,
        });
      }
      if (section.rows.length)
        for (let i = 0; i < section.rows.length; i += 14) {
          const slide = slides.addSlide();
          slide.addText(section.heading || data.title, {
            x: 0.6,
            y: 0.3,
            w: 12,
            h: 0.7,
            fontSize: 26,
            bold: true,
            color: "435EE5",
          });
          slide.addTable(
            section.rows
              .slice(i, i + 14)
              .map((row) => row.map((v) => ({ text: String(v ?? "") }))),
            {
              x: 0.6,
              y: 1.2,
              w: 12,
              fontFace: "Microsoft YaHei",
              fontSize: 12,
              color: "25304A",
              border: { color: "D7DCF0", pt: 1 },
              fill: { color: "F6F7FC" },
              autoPage: true,
              autoPageRepeatHeader: true,
            },
          );
        }
    }
    return {
      content: Buffer.from(
        (await slides.write({ outputType: "nodebuffer" })) as ArrayBuffer,
      ),
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
  }
  const text =
    data.format === "csv"
      ? "\ufeff" +
        data.sections
          .flatMap((s) => s.rows)
          .map((row) =>
            row
              .map((v) => {
                let value = String(v ?? "");
                if (/^[=+@\-\t\r]/.test(value)) value = "'" + value;
                return '"' + value.replace(/"/g, '""') + '"';
              })
              .join(","),
          )
          .join("\r\n")
      : flat();
  return {
    content: Buffer.from(text || data.title, "utf8"),
    mime:
      data.format === "csv"
        ? "text/csv"
        : data.format === "md"
          ? "text/markdown"
          : "text/plain",
  };
}
