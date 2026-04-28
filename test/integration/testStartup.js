"use strict";

const path = require("node:path");
const { tests } = require("@iobroker/testing");

tests.integration(path.join(__dirname, "../.."));
