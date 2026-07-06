import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: "50%",
          background: "radial-gradient(circle at 35% 35%, #ffbe00, #c53637)",
        }}
      />
    ),
    { ...size },
  );
}
