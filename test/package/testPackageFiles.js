"use strict";

const path = require("node:path");
const { tests } = require("@iobroker/testing");

tests.packageFiles(path.join(__dirname, "../.."));
