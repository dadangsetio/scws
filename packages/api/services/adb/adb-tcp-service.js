import fs from "node:fs/promises";
import { BIN, VERSION } from "@yume-chan/fetch-scrcpy-server";
import { Adb, ADB_SYNC_MAX_PACKET_SIZE } from "@yume-chan/adb";
import {
	ReadableStream,
	Consumable,
	InspectStream,
	DistributionStream,
} from "@yume-chan/stream-extra";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AdbServerClient } from "@yume-chan/adb";

import {
	CodecOptions,
	ScrcpyInstanceId,
	DEFAULT_SERVER_PATH,
	ScrcpyLogLevel,
	ScrcpyOptionsLatest,
	ScrcpyOptions2_3,
	ScrcpyVideoOrientation,
} from "@yume-chan/scrcpy";

import {
	AdbScrcpyClient,
	AdbScrcpyOptionsLatest,
	AdbScrcpyOptions2_1,
} from "@yume-chan/adb-scrcpy";
import { logger } from "../logger.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { global } from "../../state/global.js";
const __dirname = dirname(fileURLToPath(import.meta.url));

export class ProgressStream extends InspectStream {
	constructor(onProgress) {
		let progress = 0;
		super((chunk) => {
			progress += chunk.value.byteLength;
			onProgress(progress);
		});
	}
}

logger.info(`VERSION=${VERSION}`); // 2.1

global.metainfo.version = VERSION;
const server = await fs.readFile(BIN);
const connector = new AdbServerNodeTcpConnector({
	host: "localhost",
	port: 5037,
});
const serverClient = new AdbServerClient(connector);

const pushServer = async (adbInstance, path) => {
	await AdbScrcpyClient.pushServer(
		adbInstance,
		new ReadableStream({
			start(controller) {
				controller.enqueue(new Consumable(server));
				controller.close();
			},
		})
			.pipeThrough(new DistributionStream(ADB_SYNC_MAX_PACKET_SIZE))
			.pipeThrough(
				new ProgressStream((progress) => {
					// serverUploadedSize = progress;
				}),
			),
		path,
	);
};

// Every launch gets its own jar. scrcpy (cleanup=true) deletes the jar it was
// started from, so with one shared DEFAULT_SERVER_PATH any session's cleanup
// could delete the file another session / probe was about to launch from ->
// ClassNotFoundException: com.genymobile.scrcpy.Server -> "scrcpy server
// exited prematurely". That was the reason for the old push-before-everything
// plus retry loops, and it still raced.
const uniqueServerPath = () =>
	`/data/local/tmp/scws-${crypto.randomUUID().slice(0, 8)}.jar`;

const removeServer = (adbInstance, path) =>
	Promise.resolve()
		.then(() => adbInstance.rm(path, { force: true }))
		.catch(() => {});

class AdbTcpService {
	numOfTrials = 10;
	// Per-serial state kept across metainfo() polls. Previously every poll
	// opened a fresh ADB transport per device (never closed: each holds a
	// socket to the ADB server) and re-ran the display/encoder probes, which
	// launch scrcpy-server twice per device - constant load on slow
	// software-rendered emulators and multi-second stream setup.
	models = new Map(); // serial -> { serial, transport, adb, displays, encoders }
	probes = new Map(); // serial -> in-flight probe promise

	forgetDevice(serial) {
		const model = this.models.get(serial);
		this.models.delete(serial);
		if (model) {
			Promise.resolve()
				.then(() => model.adb.close())
				.catch(() => {});
		}
	}

	async getFeatures() {
		const result = await serverClient.getServerFeatures();
		return result;
	}

	async getDevices() {
		const result = await serverClient.getDevices();
		return result;
	}

	async connectToDevice(serial) {
		const transport = await serverClient.createTransport({
			serial,
		});
		const adb = new Adb(transport);
		const model = {
			serial,
			transport,
			adb,
			displays: [],
			encoders: [],
		};
		// Emulator restart / unplug: drop the dead transport so the next poll
		// reconnects and re-pushes the server.
		adb.disconnected
			.then(() => {
				if (this.models.get(serial) === model) this.forgetDevice(serial);
			})
			.catch(() => {});
		return model;
	}

	async getDeviceDisplays(deviceAdb, serial) {

		let result = [];
		let trial = 0;
		// retrial logic, because sometimes no displays are being retrieved
		while (!result?.length && trial < this.numOfTrials) {
			const path = uniqueServerPath();
			try {
				await pushServer(deviceAdb, path);
				result = await AdbScrcpyClient.getDisplays(
					deviceAdb,
					path,
					VERSION,
					new AdbScrcpyOptionsLatest(
						new ScrcpyOptionsLatest({
							logLevel: ScrcpyLogLevel.Debug,
						}),
					),
				);
			} finally {
				await removeServer(deviceAdb, path);
			}
			trial++;
		}
		logger.info(`getDeviceDisplays in trial=${trial}`);
		return result;
	}

	async getDeviceEncoders(deviceAdb, serial) {
		let result = [];
		let trial = 0;
		// retrial logic, because sometimes no encoders are being retrieved
		while (!result?.length && trial < this.numOfTrials) {
			const path = uniqueServerPath();
			try {
				await pushServer(deviceAdb, path);
				result = await AdbScrcpyClient.getEncoders(
					deviceAdb,
					path,
					VERSION,
					new AdbScrcpyOptionsLatest(
						new ScrcpyOptionsLatest({
							logLevel: ScrcpyLogLevel.Debug,
						}),
					),
				);
			} finally {
				await removeServer(deviceAdb, path);
			}
			trial++;
		}
		logger.info(`getDeviceEncoders in trial=${trial}`);
		return result;
	}

	async start(deviceAdb, user, wsData = user.ws) {
		const {
			audio,
			audioCodec,
			audioEncoder,
			video,
			videoCodec,
			videoEncoder,
			videoBitRate,
			displayId,
			maxSize,
			maxFps,
		} = wsData;
		const videoCodecOptions = new CodecOptions({});
		const audioCodecOptions = new CodecOptions();

		const config = {
			audio,
			audioCodec,
			audioEncoder,
			video,
			videoCodec,
			videoEncoder,
			videoBitRate,
			displayId,
			maxSize,
			maxFps,
			logLevel: ScrcpyLogLevel.Debug,
			scid: ScrcpyInstanceId.random(),
			lockVideoOrientation: ScrcpyVideoOrientation.Unlocked,
			// sendDeviceMeta: false,
			// sendFrameMeta: false,
			// sendCodecMeta: false,
			// sendDummyByte: false,
			cleanup: true,
			tunnelForward: true,
			videoCodecOptions,
			audioCodecOptions,
		};
		const options = new AdbScrcpyOptions2_1(new ScrcpyOptions2_3(config));

		// scrcpy's own cleanup deletes this jar when the session ends.
		const path = uniqueServerPath();
		await pushServer(deviceAdb, path);
		let client;
		try {
			client = await AdbScrcpyClient.start(deviceAdb, path, VERSION, options);
		} catch (err) {
			await removeServer(deviceAdb, path);
			throw err;
		}
		return {
			client,
			options,
		};
	}

	async getDeviceAdb(deviceSerial) {
		let device = this.models.get(deviceSerial);
		if (!device) {
			await this.metainfo();
			device = this.models.get(deviceSerial);
		}
		if (!device) {
			throw new Error(
				`Device with serial = '${deviceSerial}' is not connected.`,
			);
		}
		return device.adb;
	}

	// Connect + probe a device once; later polls reuse the cached model. Only a
	// device whose probe came back empty is re-probed (on the same transport).
	ensureDevice(serial) {
		const cached = this.models.get(serial);
		if (cached?.displays.length && cached?.encoders.length) {
			return Promise.resolve(cached);
		}
		let probe = this.probes.get(serial);
		if (!probe) {
			probe = (async () => {
				let model = this.models.get(serial);
				if (!model) {
					model = await this.connectToDevice(serial);
					this.models.set(serial, model);
				}
				const [displays, encoders] = await Promise.all([
					this.getDeviceDisplays(model.adb, serial),
					this.getDeviceEncoders(model.adb, serial),
				]);
				model.displays = displays;
				model.encoders = encoders;
				return model;
			})().finally(() => this.probes.delete(serial));
			this.probes.set(serial, probe);
		}
		return probe;
	}

	async metainfo() {
		const [features, devices] = await Promise.all([
			this.getFeatures(),
			this.getDevices(),
		]);
		const present = new Set(devices.map((d) => d.serial));
		for (const serial of [...this.models.keys()]) {
			if (!present.has(serial)) this.forgetDevice(serial);
		}
		const deviceModels = await Promise.all(
			devices.map((d) => this.ensureDevice(d.serial)),
		);
		global.metainfo.features = features;
		global.metainfo.devices = deviceModels;

		return {
			version: global.metainfo.version,
			features: global.metainfo.features,
			devices: global.metainfo.devices.map((d) => ({
				serial: d.serial,
				displays: d.displays,
				encoders: d.encoders,
			})),
		};
	}

}

export const service = new AdbTcpService();
