import {capturePreflight, createAdbExecutor} from './capture-owner.mjs';
capturePreflight({directory: process.env.EVIDENCE + '/public', execute: createAdbExecutor({temporaryDirectory: process.env.TMPDIR})});
