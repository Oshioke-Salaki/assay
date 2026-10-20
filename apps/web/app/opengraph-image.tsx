import { ImageResponse } from "next/og";

export const alt = "Assay, the credit bureau for agent payments on Celo";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Share card: the mark, the name, and what it is. */
export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "#161719",
        color: "#f1f1ef",
      }}
    >
      <svg width="132" height="132" viewBox="0 0 100 100">
        <title>Assay</title>
        <path
          d="M38 0H62L100 38V100H66L50 64L34 100H0V38Z M50 22L59 48H41Z"
          fill="#fcff52"
          fillRule="evenodd"
        />
      </svg>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 150, fontWeight: 800, letterSpacing: "-0.06em", lineHeight: 0.9 }}>Assay</div>
        <div style={{ fontSize: 40, marginTop: 24, color: "#b9bbc0" }}>
          The credit bureau for agent payments on Celo
        </div>
      </div>
    </div>,
    size,
  );
}
