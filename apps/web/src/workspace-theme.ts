import { theme, type ThemeConfig } from "antd";

// Route-scoped: operational tables keep their existing visual theme.
export const workspaceTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#a08bff",
    colorInfo: "#a08bff",
    colorInfoBg: "#24203a",
    colorInfoBorder: "#433960",
    colorBgLayout: "#0c0e16",
    colorBgContainer: "#151822",
    colorBgElevated: "#1c2030",
    colorText: "#eceef8",
    colorTextSecondary: "#9a9fb6",
    colorTextPlaceholder: "#777d94",
    colorBorder: "#303448",
    colorBorderSecondary: "#262a3b",
    borderRadius: 10,
    controlHeight: 34,
  },
  components: {
    Button: { controlHeight: 34, primaryShadow: "none" },
    Menu: {
      darkItemBg: "transparent",
      darkSubMenuItemBg: "transparent",
      darkItemColor: "#a7adc4",
      darkItemSelectedBg: "#27233e",
      darkItemSelectedColor: "#d3caff",
      itemHeight: 42,
      itemBorderRadius: 10,
    },
    Card: { headerHeight: 58, headerPadding: 22, bodyPadding: 22 },
  },
};

// The existing detailed report uses its own light chart and table palette.
export const workspaceReportTheme: ThemeConfig = {
  inherit: false,
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: "#7965d7",
    colorInfo: "#7965d7",
    colorText: "#362a22",
    fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
    borderRadius: 8,
  },
};
