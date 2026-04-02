import { NextResponse } from "next/server";
import { getCacheStats, clearCache, cleanExpiredEntries } from "@/lib/semanticCache";

export async function GET() {
  try {
    const stats = getCacheStats();
    return NextResponse.json({
      ...stats,
      // Backward-compatible aliases for older dashboard cards.
      size: stats.totalEntries,
      maxSize: stats.memoryMaxEntries,
      bytes: stats.memoryBytes,
      maxBytes: stats.memoryMaxBytes,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as any).message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const cleaned = cleanExpiredEntries();
    clearCache();
    return NextResponse.json({
      success: true,
      expiredRemoved: cleaned,
      message: "Semantic cache cleared",
    });
  } catch (error) {
    return NextResponse.json({ error: (error as any).message }, { status: 500 });
  }
}
