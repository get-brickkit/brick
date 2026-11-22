import { app } from "./app";

const port = Number(process.env.PORT ?? 4310);
app.listen(port);
console.log(`sprite stack  http://localhost:${port}`);
console.log(`stack action  POST http://localhost:${port}/api/sprites/stack`);
console.log(`mcp tool      POST http://localhost:${port}/mcp`);
