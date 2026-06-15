import { ImageResponse } from "next/og";
import { SITE_NAME, SOCIAL_IMAGE } from "./lib/metadata/site-metadata";

export const size = {
  width: 1200,
  height: 630,
};

export const alt = SOCIAL_IMAGE.alt;

export const contentType = "image/png";

export default function OpenGraphImage() {
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
          overflow: "hidden",
          position: "relative",
          width: "100%",
        }}>
        <div
          style={{
            background: "rgba(126, 141, 135, 0.18)",
            borderRadius: 999,
            filter: "blur(4px)",
            height: 360,
            left: -100,
            position: "absolute",
            top: -120,
            width: 360,
          }}
        />
        <div
          style={{
            background: "rgba(168, 174, 184, 0.22)",
            borderRadius: 999,
            bottom: -120,
            filter: "blur(4px)",
            height: 420,
            position: "absolute",
            right: -90,
            width: 420,
          }}
        />
        <div
          style={{
            alignItems: "center",
            background: "rgba(250, 250, 248, 0.78)",
            border: "1px solid rgba(126, 141, 135, 0.32)",
            borderRadius: 48,
            boxShadow: "0 30px 90px rgba(44, 43, 40, 0.12)",
            display: "flex",
            flexDirection: "column",
            height: 430,
            justifyContent: "center",
            padding: "64px 88px",
            width: 940,
          }}>
          <div
            style={{
              color: "#7E8D87",
              fontFamily: "serif",
              fontSize: 36,
              letterSpacing: 1.4,
              lineHeight: 1,
              marginBottom: 38,
              textTransform: "uppercase",
            }}>
            Lille
          </div>
          <div
            style={{
              color: "#2C2B28",
              fontFamily: "serif",
              fontSize: 102,
              fontWeight: 500,
              letterSpacing: -1.5,
              lineHeight: 0.95,
              textAlign: "center",
            }}>
            {SITE_NAME}
          </div>
          <div
            style={{
              background: "#7E8D87",
              height: 2,
              marginBottom: 36,
              marginTop: 38,
              width: 150,
            }}
          />
          <div
            style={{
              color: "#565451",
              fontFamily: "sans-serif",
              fontSize: 42,
              fontWeight: 400,
              lineHeight: 1.25,
              textAlign: "center",
            }}>
            Maquillage permanent naturel
          </div>
        </div>
      </div>
    ),
    size,
  );
}
