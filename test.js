import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

async function testConnection() {
  try {
    const result = await sql`SELECT NOW() as now`;
    console.log("Connected! Current time:", result[0].now);
  } catch (error) {
    console.error("Failed to connect to DB:", error);
  }
}

testConnection();
