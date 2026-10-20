import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the mark in Celo yellow on touchstone black. */
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#161719",
      }}
    >
      <svg width="120" height="120" viewBox="0 0 100 100">
        <title>Assay</title>
        <path
          d="M38 0H62L100 38V100H66L50 64L34 100H0V38Z M50 22L59 48H41Z"
          fill="#fcff52"
          fillRule="evenodd"
        />
      </svg>
    </div>,
    size,
  );
}
