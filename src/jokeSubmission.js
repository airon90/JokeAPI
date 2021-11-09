const scl = require("svcorelib");
const fs = require("fs-extra");
const http = require("http");
const { resolve, join } = require("path");
const sanitizePath = require("sanitize-filename");

const parseJokes = require("./parseJokes");
const logRequest = require("./logRequest");
const convertFileFormat = require("./fileFormatConverter");
const analytics = require("./analytics");
const parseURL = require("./parseURL");
const meter = require("./meter");
const tr = require("./translate");
const fileFormatConverter = require("./fileFormatConverter");
const { isValidLang } = require("./languages");

// common HTTP functions
const { pipeString, respondWithError } = require("./httpCommon");

const settings = require("../settings");

scl.unused(http, analytics, tr);

/** @typedef {parseJokes.SingleJoke|parseJokes.TwopartJoke} JokeSubmission */
/** @typedef {import("./fileFormatConverter").FileFormat} FileFormat */
/** @typedef {import("./types/analytics").AnalyticsObject} AnalyticsObject */
/** @typedef {import("./types/analytics").Submission} AnalyticsSubmission */
/** @typedef {import("./types/jokes").Joke} Joke */
/** @typedef {import("./types/jokes").JokeSubmission} Submission */


/**
 * To be called when a joke is submitted
 * @param {http.ServerResponse} res
 * @param {string|object} data
 * @param {string} fileFormat
 * @param {string} ip
 * @param {AnalyticsObject} analyticsObject
 * @param {boolean} dryRun Set to true to not add the joke to the joke file after validating it
 * @param {string} lang API response langauge (not joke submission language) - defaults to `settings.languages.defaultLanguage`
 */
function jokeSubmission(res, data, fileFormat, ip, analyticsObject, dryRun, lang)
{
    if(!isValidLang(lang))
        lang = settings.languages.defaultLanguage;

    try
    {
        if(dryRun !== true)
            dryRun = false;

        const getSubmission = () => {
            /** @type {Submission} */
            let sub = typeof data === "string" ? JSON.parse(data) : data;

            if(sub.type === "single")
                sub.joke = sub.joke.normalize("NFC");
            else if(sub.type === "twopart")
            {
                sub.setup = sub.setup.normalize("NFC");
                sub.delivery = sub.delivery.normalize("NFC");
            }

            return sub;
        }

        const submission = getSubmission();

        const submissionLang = (submission.lang || settings.languages.defaultLanguage).toString().toLowerCase();

        if(scl.isEmpty(submission))
            return respondWithError(res, 105, 400, fileFormat, tr(lang, "requestBodyIsInvalid"), lang);

        const invalidChars = data.match(settings.jokes.submissions.invalidCharRegex);
        const invalidCharsStr = invalidChars ? invalidChars.map(ch => `0x${ch.charCodeAt(0).toString(16)}`).join(", ") : null;
        if(invalidCharsStr && invalidChars.length > 0)
            return respondWithError(res, 109, 400, fileFormat, tr(lang, "invalidChars", invalidCharsStr), lang);

        if(submission.formatVersion == parseJokes.jokeFormatVersion && submission.formatVersion == settings.jokes.jokesFormatVersion)
        {
            // format version is correct, validate joke now
            const validationResult = parseJokes.validateSubmission(submission, lang);

            if(!validationResult.valid)
            {
                // joke is invalid, respond with error
                const clientResponse = {
                    error: true,
                    internalError: false,
                    code: 105,
                    message: tr(lang, "submissionMalformedJoke"),
                    causedBy: validationResult.errorStrings,
                    additionalInfo: "",
                    validProperties: validationResult.jokeParams,
                    timestamp: Date.now(),
                };

                return scl.http.pipeString(res, fileFormatConverter.auto(fileFormat, clientResponse, lang), parseURL.getMimeType(fileFormat), 400);
                // return httpServer.respondWithError(res, 105, 400, fileFormat, tr(langCode, "submittedJokeFormatInvalid", validationResult.join("\n")), langCode);
            }
            else
            {
                // joke is valid, find file path and then write to file

                const filePath = getSubmissionFilePath(res, fileFormat, lang, ip, submissionLang, analyticsObject);

                try
                {
                    // file name was found, write to file now:
                    if(dryRun)
                    {
                        const respObj = {
                            error: false,
                            message: tr(lang, "dryRunSuccessful"),
                            submission,
                            validProperties: validationResult.jokeParams,
                            timestamp: Date.now(),
                        };

                        return pipeString(res, fileFormatConverter.auto(fileFormat, respObj, lang), parseURL.getMimeType(fileFormat), 201);
                    }

                    return writeJokeToFile(res, filePath, submission, fileFormat, ip, analyticsObject, validationResult, lang);
                }
                catch(err)
                {
                    return respondWithError(res, 100, 500, fileFormat, tr(lang, "errWhileSavingSubmission", err), lang);
                }
            }
        }
        else
        {
            return respondWithError(res, 105, 400, fileFormat, tr(lang, "wrongFormatVersion", parseJokes.jokeFormatVersion, submission.formatVersion), lang);
        }
    }
    catch(err)
    {
        return respondWithError(res, 105, 400, fileFormat, tr(lang, "invalidJSON", err), lang);
    }
}

/**
 * Builds a file path for a joke submission and returns it
 * @param {http.ServerResponse} res 
 * @param {FileFormat} fileFormat 
 * @param {string} lang 
 * @param {string} ip 
 * @param {string} submissionLang 
 * @param {AnalyticsSubmission} analyticsObject 
 * @returns {string}
 */
function getSubmissionFilePath(res, fileFormat, lang, ip, submissionLang, analyticsObject)
{
    const curTS = Date.now();
    const sanitizedIP = ip.replace(settings.httpServer.ipSanitization.regex, settings.httpServer.ipSanitization.replaceChar).substring(0, 16);

    let filePath = join(settings.jokes.jokeSubmissionPath, submissionLang, `/${sanitizePath(`submission_${sanitizedIP}_0_${curTS}.json`)}`);

    let iter = 0;
    const findNextNum = currentNum => {
        iter++;
        if(iter >= settings.httpServer.rateLimiting)
        {
            logRequest("ratelimited", `IP: ${ip}`, analyticsObject);
            return respondWithError(res, 101, 429, fileFormat, tr(lang, "rateLimited", settings.httpServer.rateLimiting, settings.httpServer.timeFrame));
        }

        if(fs.existsSync(join(settings.jokes.jokeSubmissionPath, sanitizePath(`submission_${sanitizedIP}_${currentNum}_${curTS}.json`))))
            return findNextNum(currentNum + 1);
        else
            return currentNum;
    };

    fs.ensureDirSync(join(settings.jokes.jokeSubmissionPath, submissionLang));

    if(fs.existsSync(join(settings.jokes.jokeSubmissionPath, filePath)))
        filePath = join(settings.jokes.jokeSubmissionPath, submissionLang, `/${sanitizePath(`submission_${sanitizedIP}_${findNextNum()}_${curTS}.json`)}`);

    // convert to absolute path
    return resolve(filePath);
}

/**
 * Writes a joke to a json file
 * @param {http.ServerResponse} res
 * @param {string} filePath
 * @param {JokeSubmission} submittedJoke
 * @param {string} fileFormat
 * @param {string} ip
 * @param {AnalyticsObject} analyticsObject
 * @param {parseJokes.ValidationResult} validationResult
 * @param {string} [langCode]
 */
function writeJokeToFile(res, filePath, submittedJoke, fileFormat, ip, analyticsObject, validationResult, langCode)
{
    const reformattedJoke = reformatJoke(submittedJoke);

    fs.writeFile(filePath, JSON.stringify(reformattedJoke, null, 4), err => {
        if(!err)
        {
            // successfully wrote to file
            const responseObj = {
                error: false,
                message: tr(langCode, "submissionSaved"),
                submission: reformattedJoke,
                validProperties: validationResult.jokeParams,
                timestamp: Date.now(),
            };

            meter.update("submission", 1);

            const submissionObject = analyticsObject;
            submissionObject.submission = reformattedJoke;
            logRequest("submission", ip, submissionObject);

            return pipeString(res, convertFileFormat.auto(fileFormat, responseObj, langCode), parseURL.getMimeType(fileFormat), 201);
        }
        // error while writing to file
        else
            return respondWithError(res, 100, 500, fileFormat, tr(langCode, "errWhileSavingSubmission", err), langCode);
    });
}

/**
 * Coarse filter that ensures that a joke is formatted as expected.  
 * This doesn't do any validation and omits missing properties!
 * @param {Joke|JokeSubmission} joke
 * @returns {Joke|JokeSubmission} Returns the reformatted joke
 */
function reformatJoke(joke)
{
    let retJoke = {};

    if(joke.formatVersion)
        retJoke.formatVersion = joke.formatVersion;

    retJoke = {
        ...retJoke,
        category: typeof joke.category === "string" ? parseJokes.resolveCategoryAlias(joke.category) : joke.category,
        type: joke.type
    };

    if(joke.type === "single")
    {
        retJoke.joke = joke.joke;
    }
    else if(joke.type === "twopart")
    {
        retJoke.setup = joke.setup;
        retJoke.delivery = joke.delivery;
    }

    retJoke.flags = {
        nsfw: joke.flags.nsfw,
        religious: joke.flags.religious,
        political: joke.flags.political,
        racist: joke.flags.racist,
        sexist: joke.flags.sexist,
        explicit: joke.flags.explicit,
    };

    if(joke.lang)
        retJoke.lang = joke.lang;

    if(typeof retJoke.lang === "string")
        retJoke.lang = retJoke.lang.toLowerCase();

    retJoke.safe = joke.safe || false;

    if(joke.id)
        retJoke.id = joke.id;

    return retJoke;
}

module.exports = jokeSubmission;
module.exports.reformatJoke = reformatJoke;
