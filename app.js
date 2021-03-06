'use strict';

const WebSocket = require('ws');
const fs = require('fs');

global.sqlite3 = require('sqlite3');
global.Tools = require('./tools.js');
try {
	global.Config = require('./config/config.js');
} catch (err) {
	if (err.code !== 'MODULE_NOT_FOUND') throw err;
	fs.writeFileSync('config/config.js', fs.readFileSync('config/config-example.js'));
	return console.log("Please edit config/config.js before running the bot");
}
if (Config.servers['exampleserver']) return console.log("Please edit config/config.js before running the bot");
global.Parser = require('./parser.js');
global.Servers = {};

if (Config.watchconfig) {
	fs.watchFile('config/config.js', function (curr, prev) {
		if (curr.mtime <= prev.mtime) return;
		try {
			delete require.cache[require.resolve('./config/config.js')];
			global.Config = require('./config/config.js');
			console.log('Reloaded config/config.js');
		} catch (e) {}
	});
}

global.toId = function (text) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
};

for (let server in Config.servers) {
	if (Config.servers[server].rooms instanceof Array) {
		Config.servers[server].rooms = Config.servers[server].rooms.map(toId);
	}
	if (Config.servers[server].privaterooms instanceof Array) {
		Config.servers[server].privaterooms = Config.servers[server].privaterooms.map(toId);
	}
}


class Server {
	 constructor(server) {
		for (let u in server) this[u] = server[u];
		this.parser = new Parser(server.id);
		this.roomList = {'official': [], 'chat': []};
		this.connected = false;
		this.joinedRooms = false;

		this.connection = new WebSocket('ws://' + this.ip + ':' + this.port + '/showdown/websocket');

		this.connection.on('open', () => {
			Tools.log('Connected to ' + this.id, this.id);
			this.connected = true;
		});

		this.connection.on('error', error => {
			Tools.log('Error: ' + error, this.id, true);
		});

		this.connection.on('message', data => {
			if (!data || data.length < 1) return;
			Tools.log('> [' + this.id + '] ' + data, this.id);
			let roomid = 'lobby';
			if (data.charAt(0) === '>') {
				roomid = data.substr(1, data.indexOf('\n') - 1);
				data = data.substr(data.indexOf('\n') + 1, data.length);
			}
			if (roomid.substr(0, 6) === 'battle') {
				let split = data.split('\n');
				for (let line in split) {
					this.parser.parse(roomid, split[line], Servers[this.id]);
				}
				return;
			}
			this.parser.parse(roomid, data, Servers[this.id]);
		});

		this.connection.on('close', (code, message) => {
			this.connected = false;
			if (this.disconnecting) return;
			Tools.log('Connection lost to ' + this.id + ': ' + message, this.id);
			delete Servers[this.id];
			if (!this.autoreconnect) return;
			Tools.log('Reconnecting to ' + this.id + ' in one minute.', this.id);
			let reconnect = setTimeout(() => {
				connect(this.id);
				clearInterval(reconnect);
			}, 60 * 1000);
		});

		if (server.ping) { // this is needed to stay connected to tbt and I'm not sure why
			this.ping = setInterval(() => {
				if (!this.connected) return clearInterval(this.ping);
				this.connection.ping();
			}, server.ping);
		}

		this.lastMessageTime = 0;
		this.chatQueue = [];
	}

	send(message, room) {
		if (!this.connected) return false;
		if ((Date.now() - this.lastMessageTime) < 600) {
			if (this.chatQueue.length < 1) {
				this.processingChatQueue = setInterval(() => {
					this.processChatQueue();
				}, 600);
			}
			return this.chatQueue.push([message, room]);
		}
		if (!room) room = '';
		try {
			this.connection.send(room + '|' + message);
		} catch (e) {
			Tools.log('Sending "' + room + '|' + message + '" crashed: ' + e.stack, this.id);
		}
		this.lastMessageTime = Date.now();
		Tools.log('> [' + this.id + '] ' + (room !== '' ? '[' + room + '] ' : '[] ') + message, this.id);
	}

	processChatQueue() {
		if (this.chatQueue.length < 1 || (Date.now() - this.lastMessageTime) < 600) return;
		this.send(this.chatQueue[0][0], this.chatQueue[0][1]);
		this.lastMessageTime = Date.now();
		this.chatQueue.splice(0, 1);
		if (this.chatQueue.length < 1) clearInterval(this.processingChatQueue);
	}
}

function connect(server) {
	if (!Config.servers[server]) return console.log('Server "' + server + '" not found.');
	server = Config.servers[server];
	if (server.disabled) return;
	Tools.log('Connecting to ' + server.id + '.', server.id);
	if (Servers[server.id]) return Tools.log('Already connected to ' + server.id + '. Connection aborted.', server.id);
	Servers[server.id] = new Server(server);
}
global.connect = connect;

let count = 0;

if (!Object.keys(Config.servers)[count]) {
	console.log("Please edit config.js and specify a server to connect to.");
	return process.exit();
}
connect(Object.keys(Config.servers)[count]);
count++;

let connectTimer = setInterval(function () {
	if (!Object.keys(Config.servers)[count]) return clearInterval(connectTimer);
	connect(Object.keys(Config.servers)[count]);
	count++;
}, 1000); // this delay is to avoid problems logging into multiple servers so quickly


/*
 * static web server for displaying chat logs with the viewlogs command.
 */

const nodestatic = require('node-static');
const staticserver = new nodestatic.Server('./static');
const app = require('http').createServer();
let staticRequestHandler = function (request, response) {
	request.resume();
	request.addListener('end', function () {
		if (/^\/([A-Za-z0-9][A-Za-z0-9-]*)\/?$/.test(request.url)) {
			request.url = '/';
		}
		staticserver.serve(request, response, function (e, res) {
			if (e && (e.status === 404)) {
				staticserver.serveFile('404.html', 404, {}, request, response);
			}
		});
	});
};
app.on('request', staticRequestHandler);
app.listen(Config.webport);
