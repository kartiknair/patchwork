import CollabSynth from "./CollabSynth";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return <CollabSynth roomId={roomId} />;
}
