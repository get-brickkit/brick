#!/usr/bin/env node

import("../dist/cli.js")
  .then((module) => {
    return module.setupRedis();
  })
  .catch((err) => {
    console.error("Failed to load CLI:", err);
    process.exit(1);
  });
