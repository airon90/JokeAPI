const { unused } = require("svcorelib");

const _http = require("http");

const debug = require("../debug");
const Endpoint = require("./Endpoint");


unused("types:", _http);

/**
 * Base class for all submission endpoints POST / (PUT)
 */
class SubmissionEndpoint extends Endpoint {
    /**
     * Constructs a new object of class SubmissionEndpoint  
     * This class is intended to be subclassed! Don't use it "raw" like this!
     * @param {string} pathName At which path this endpoint will be called
     * @param {Endpoint.EndpointMeta} meta Meta information about this endpoint
     */
    constructor(pathName, meta)
    {
        super(pathName, meta);

        debug("SubmissionEndpoint", `Instantiated submission endpoint at /${pathName}/`);
    }

    //#MARKER call
    /**
     * This method is run each time a client sends data to this submission endpoint  
     * Abstract method - to be overwritten!
     * @abstract ❗️ Abstract method - Override this, else a MissingImplementationError is thrown ❗️
     * @param {_http.IncomingMessage} req The HTTP server request
     * @param {_http.ServerResponse} res The HTTP server response
     * @param {string[]} url URL path array gotten from the URL parser module
     * @param {Object} params URL query params gotten from the URL parser module
     * @param {string} format The file format to respond with
     * @param {string} data The raw data, as a string
     * @param {httpServer.HttpMetrics} httpMetrics
     * @throws Throws a MissingImplementationError if this method was not overwritten
     */
    call(req, res, url, params, format, data, httpMetrics)
    {
        unused(req, res, url, params, format, data, httpMetrics);
        throw new Endpoint.MissingImplementationError(`Method Endpoint.call() is an abstract method that needs to be overridden in a subclass of "SubmissionEndpoint"`);
    }
}

module.exports = SubmissionEndpoint;
