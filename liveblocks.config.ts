import { createClient } from "@liveblocks/client"
import { createRoomContext } from "@liveblocks/react"

const client = createClient({
  publicApiKey: process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY ?? "",
})

type Presence = {
  cursor: { x: number; y: number } | null
  name: string
  color: string
  chat: string | null
}

export const {
  RoomProvider,
  useRoom,
  useOthers,
  useSelf,
  useUpdateMyPresence,
} = createRoomContext<Presence>(client)
