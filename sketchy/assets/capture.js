/*
 *
 *  Copyright 2014 Netflix, Inc.
 *
 *     Licensed under the Apache License, Version 2.0 (the "License");
 *     you may not use this file except in compliance with the License.
 *     You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 *     Unless required by applicable law or agreed to in writing, software
 *     distributed under the License is distributed on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *     See the License for the specific language governing permissions and
 *     limitations under the License.
 *
 */
// PhantomJS script
// Takes screeshot of a given page. This correctly handles pages which
// dynamically load content making AJAX requests.

// Instead of waiting fixed amount of time before rendering, we give a short
// time for the page to make additional requests.



var _ = require('./lodash.js');
var fs = require('fs');


if (!Date.prototype.toISOString) {
    Date.prototype.toISOString = function () {
        function pad(n) { return n < 10 ? '0' + n : n; }
        function ms(n) { return n < 10 ? '00'+ n : n < 100 ? '0' + n : n }
        return this.getFullYear() + '-' +
            pad(this.getMonth() + 1) + '-' +
            pad(this.getDate()) + 'T' +
            pad(this.getHours()) + ':' +
            pad(this.getMinutes()) + ':' +
            pad(this.getSeconds()) + '.' +
            ms(this.getMilliseconds()) + 'Z';
    }
}


// createHAR and supporting code adapted from https://github.com/ariya/phantomjs/blob/master/examples/netsniff.js
function createHAR(address, title, startTime, resources, endTime)
{
    var entries = [];

    resources.forEach(function (resource) {
        var request = resource.request,
            startReply = resource.startReply,
            endReply = resource.endReply;

        if (!request || !startReply || !endReply) {
            return;
        }

        // Exclude Data URI from HAR file because
        // they aren't included in specification
        if (request.url.match(/(^data:image\/.*)/i)) {
            return;
	}

        entries.push({
            startedDateTime: request.time.toISOString(),
            time: endReply.time - request.time,
            request: {
                method: request.method,
                url: request.url,
                httpVersion: "HTTP/1.1",
                cookies: [],
                headers: request.headers,
                queryString: [],
                headersSize: -1,
                bodySize: -1
            },
            response: {
                status: endReply.status,
                statusText: endReply.statusText,
                httpVersion: "HTTP/1.1",
                cookies: [],
                headers: endReply.headers,
                redirectURL: "",
                headersSize: -1,
                bodySize: startReply.bodySize,
                content: {
                    size: startReply.bodySize,
                    mimeType: endReply.contentType
                }
            },
            cache: {},
            timings: {
                blocked: 0,
                dns: -1,
                connect: -1,
                send: 0,
                wait: startReply.time - request.time,
                receive: endReply.time - startReply.time,
                ssl: -1
            },
            pageref: address
        });
    });

    return {
        log: {
            version: '1.2',
            creator: {
                name: "PhantomJS",
                version: phantom.version.major + '.' + phantom.version.minor +
                    '.' + phantom.version.patch
            },
            pages: [{
                startedDateTime: startTime.toISOString(),
                id: address,
                title: title,
                pageTimings: {
                    onLoad: endTime - startTime
                }
            }],
            entries: entries
        }
    };
}

var defaultOpts = {
    // How long do we wait for additional requests
    //after all initial requests have got their response
    ajaxTimeout: 1000,

    // How long do we wait at max
    maxTimeout: 8000
};

var Page = (function(opts) {
    opts = _.extend(defaultOpts, opts);
    var requestCount = 0;
    var forceRenderTimeout;
    var ajaxRenderTimeout;

    var page = require('webpage').create();

    page.resources = [];

    page.viewportSize = {
        width: opts.width,
        height: opts.height
    };

    page.settings.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/36.0.1944.0 Safari/537.36';
    page.customHeaders = {
      // Nullify Accept-Encoding header to disable compression (https://github.com/ariya/phantomjs/issues/10930)
      'Accept-Encoding': ' '
    };

    page.onLoadStarted = function () {

        page.startTime = new Date();
    };



    page.onInitialized = function() {
        page.customHeaders = {};
    };
    // Silence confirmation messages and errors
    page.onConfirm = page.onPrompt = page.onError = noop;

    page.onbeforeunload = function (e) {
        requestCount += 1; // This may mess up the count, but we don't want to time out after a redir.
        clearTimeout(ajaxRenderTimeout);
    };

    page.onResourceRequested = function(request) {
        requestCount += 1;
        clearTimeout(ajaxRenderTimeout);
        page.resources[request.id] = {
            request: request,
            startReply: null,
            endReply: null
        };
    };

    page.onResourceReceived = function(response) {
        if (!response.stage || response.stage === 'end') {
            requestCount -= 1;
            if (requestCount === 0) {
                ajaxRenderTimeout = setTimeout(renderAndExit, opts.ajaxTimeout);
            }
        }

        if (response.stage === 'start') {
            page.resources[response.id].startReply = response;
        }
        if (response.stage === 'end') {
            page.resources[response.id].endReply = response;
        }
    };



    var api = {};

    api.render = function(url, file) {
        opts.file = file;

        page.open(url, function(status) {
            if (status !== "success") {
                console.error('Unable to load url:', url);
                phantom.exit(1);
            } else {

                forceRenderTimeout = setTimeout(renderAndExit, opts.maxTimeout);
            }
        });
    };

    function renderAndExit() {

        page.endTime = new Date();
        page.title = page.evaluate(function () {
            return document.title;
        });

        page.render(opts.file + '.png');
        fs.write(opts.file + '.html', page.content)

        var har;

        har = createHAR(page.address, page.title, page.startTime, page.resources, page.endTime);
        //TODO: It seems odd that createHAR would need page while taking all these arguments.

        fs.write(opts.file + '.har', JSON.stringify(har, undefined, 4));


        phantom.exit();
    }

    function noop() {}

    return api;
});

function die(error) {
    console.error(error);
    phantom.exit(1);
}

function main() {
    var args = require('system').args;

    var url = args[1];
    var file = args[2];
    var width = args[3] || 1280;
    var height = args[4] || 800;

    var isHelp = args[1] === '-h' || args[1] === '--help';
    if (args.length === 1 || isHelp) {
        var help = 'Usage: phantomjs capture.js <url> <output-file-without-extension> [width] [height]\n';
        help += 'Example: phantomjs capture.js http://google.com google 1200 800';
        die(help);
    }

    if (!url) die('Url parameter must be specified');
    if (!file) die('File parameter must be specified');

    var opts = {
        width: width,
        height: height
    };

    var page = Page(opts);
    page.render(url, file);
}


main();
