import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#F5F4F1",
          color: "#2C2B28",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          position: "relative",
          width: "100%",
        }}>
        <div
          style={{
            border: "1px solid rgba(126, 141, 135, 0.45)",
            borderRadius: 42,
            bottom: 18,
            left: 18,
            position: "absolute",
            right: 18,
            top: 18,
          }}
        />
        <div
          style={{
            color: "#2C2B28",
            fontFamily: "serif",
            fontSize: 104,
            fontWeight: 600,
            letterSpacing: -2,
            lineHeight: 1,
          }}>
          E
        </div>
        <div
          style={{
            background: "#7E8D87",
            borderRadius: 999,
            bottom: 46,
            height: 12,
            position: "absolute",
            right: 46,
            width: 12,
          }}
        />
      </div>
    ),
    size,
  );
}
