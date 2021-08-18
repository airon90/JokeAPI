const mysql = require("mysql");
const promiseAllSequential = require("promise-all-sequential");
const { colors, unused } = require("svcorelib");

const parseJokes = require("../parseJokes");
const { isValidLang } = require("../languages");
const { sendQuery } = require("../sql");
const { isValidIpHash } = require("../resolveIP");
const debug = require("../debug");

const settings = require("../../settings");

const col = colors.fg;


//#MARKER types

/**
 * @typedef {object} CacheEntry An object representing an entry of the joke cache
 * @prop {string} clientIpHash 64-character IP hash of the client
 * @prop {number} jokeID ID of the joke to cache
 * @prop {string} langCode Language code of the joke to cache
 */

//#MARKER class def + constructor

/**
 * This class is in direct contact to the SQL DB.  
 * It can add to or read from the joke cache in the database table.  
 * This class also handles automatic garbage collection (clearing expired entries).
 * @since 2.4.0
 */
class JokeCache
{
    /**
     * Creates a new joke cache instance.  
     *   
     * Also sets up garbage collection to run on interval.  
     * Note: GC isn't run when constructing, only on interval!
     * @param {mysql.Connection} dbConnection
     */
    constructor(dbConnection)
    {
        /** @type {mysql.Connection} DB connection */
        this.dbConnection = dbConnection;
        this.tableName = settings.jokeCaching.tableName;

        // set up automatic GC
        try
        {
            setInterval(() => this.runGC(), 1000 * 60 * settings.jokeCaching.gcIntervalMinutes);
        }
        catch(err)
        {
            debug("JokeCache", `${col.red}Error while running garbage collector on interval: ${col.rst}${err}`, "red");
        }
    }

    //#MARKER other methods

    /**
     * Determines whether joke caching is available for a certain joke language
     * @param {string} langCode
     * @returns {boolean}
     */
    allowCaching(langCode)
    {
        try
        {
            const jokesAmount = parseJokes.jokeCountPerLang[langCode];
            return (jokesAmount >= settings.jokeCaching.jokePoolMinAmount);
        }
        catch(err)
        {
            unused(err);
            return false;
        }
    }

    /**
     * Returns the size of the joke pool of a certain language
     * @param {string} langCode
     * @returns {number}
     */
    getJokePoolSize(langCode)
    {
        const jokesAmount = parseJokes.jokeCountPerLang[langCode];
        const minPoolSize = settings.jokeCaching.jokePoolMinAmount;
        const optimalSize = settings.jokeCaching.jokePoolOptimalAmount;

        // TODO: linearly decrease pool size for languages with < `settings.jokeCaching.jokePoolOptimalAmount` jokes
    }

    //#MARKER cache stuff

    /**
     * Adds an entry to the provided client's joke cache.  
     * Use `addEntries()` for multiple entries, it is more efficient.
     * @param {string} clientIpHash 64-character IP hash of the client
     * @param {number} jokeID ID of the joke to cache
     * @param {string} langCode Language code of the joke to cache
     * @returns {Promise<object, string>}
     */
    addEntry(clientIpHash, jokeID, langCode)
    {
        debug("JokeCache", `Adding 1 entry to the joke cache - client: '${clientIpHash.substr(0, 16)}…'`);

        return new Promise((pRes, pRej) => {
            if(!this.allowCaching(langCode))
                return pRes();

            if(!isValidIpHash(clientIpHash))
                throw new TypeError(`Parameter "clientIpHash" is not a string or not a valid IP hash`);
            
            if(typeof jokeID != "number")
                jokeID = parseInt(jokeID);
            
            if(jokeID < 0)
                throw new TypeError(`Parameter "jokeID" is less than 0 (there are no negative joke IDs you dummy dum dum)`);
            
            if(!isValidLang(langCode))
                throw new TypeError(`Parameter "langCode" is not a valid language code`);

            const insValues = [
                this.tableName,
                clientIpHash,
                jokeID,
                langCode
            ];

            sendQuery(this.dbConnection, `INSERT INTO ?? (ClientIpHash, JokeID, LangCode) VALUES (?, ?, ?);`, ...insValues)
                .then(res => {
                    return pRes(res);
                }).catch(err => {
                    return pRej(err);
                });
        });
    }

    /**
     * Adds multiple entries to the provided clients' joke cache.  
     * This is more efficient than running `addEntry()` multiple times.
     * @param {string} clientIpHash 64-character IP hash of the client
     * @param {number[]} jokeIDs An array of joke IDs
     * @param {string} langCode Language code of the joke to cache
     * @returns {Promise<object, string>}
     */
    addEntries(clientIpHash, jokeIDs, langCode)
    {
        debug("JokeCache", `Adding ${jokeIDs.length} entries to the joke cache - client: '${clientIpHash.substr(0, 16)}…'`);

        return new Promise((res, rej) => {
            if(!this.allowCaching(langCode))
                return res();

            if(!isValidIpHash(clientIpHash))
                throw new TypeError(`Parameter "clientIpHash" is not a string or not a valid IP hash`);

            if(!isValidLang(langCode))
                throw new TypeError(`Parameter "langCode" is not a valid language code`);

            jokeIDs = jokeIDs.map(id => parseInt(id));

            jokeIDs.forEach(id => {
                if(id < 0)
                    throw new TypeError(`Parameter "jokeID" is less than 0 (there are no negative joke IDs you dummy dum dum)`);

                if(isNaN(id))
                    throw new TypeError(`Parameter "jokeID" couldn't be parsed as a number`);
            });

            let sqlValues = "";

            jokeIDs.forEach((jokeID, idx) => {
                let valPart = "(?, ?, ?)";

                if(idx !== (jokeIDs.length - 1))
                    valPart += ", ";

                sqlValues += mysql.format(valPart, [ clientIpHash, jokeID, langCode ]);
            });

            // sqlValues is formatted above so formatting again would break the query
            sendQuery(this.dbConnection, `INSERT INTO ?? (ClientIpHash, JokeID, LangCode) VALUES ${sqlValues};`, this.tableName)
                .then(result => {
                    return res(result);
                }).catch(err => {
                    return rej(`Err: ${err}`);
                });
        });
    }

    /**
     * Clears all joke cache entries of the specified client
     * @param {string} clientIpHash 64-character IP hash of the client
     * @throws Throws a TypeError if the client IP hash is invalid
     * @returns {Promise} Resolves with the amount of deleted entries (0 if none were found) - rejects with an instance of `Error` (see also https://www.npmjs.com/package/mysql#error-handling )
     */
    clearEntries(clientIpHash)
    {
        return new Promise((pRes, pRej) => {
            if(!isValidIpHash(clientIpHash))
                throw new TypeError(`Provided client IP hash is invalid.`);

            const insValues = [
                this.tableName,
                clientIpHash
            ];

            sendQuery(this.dbConnection, "DELETE FROM ?? WHERE ClientIpHash LIKE ?", ...insValues)
                .then(res => {
                    return pRes((res && typeof res.affectedRows === "number") ? res.affectedRows : 0);
                }).catch(err => {
                    return pRej(err);
                });
        });
    }

    /**
     * Clears the oldest entr(y/ies) of the joke cache
     * @param {string} clientIpHash 64-character IP hash of the client
     * @param {string} langCode Language code of the joke to cache
     * @param {number} [amount=1] The amount of entries that should be removed from the cache - defaults to 1
     * @returns {Promise<number, string>} Resolves with the number of entries cleared or rejects with an error message
     */
    clearOldEntries(clientIpHash, langCode, amount = 1)
    {
        return new Promise(async (res, rej) => {
            if(!this.allowCaching(langCode))
                return res(0);

            if(!isValidIpHash(clientIpHash))
                throw new TypeError(`Provided client IP hash is invalid.`);

            if(!isValidLang(langCode))
                throw new TypeError(`Parameter "langCode" is not a valid language code`);


            amount = parseInt(amount);

            if(isNaN(amount) || amount < 1)
                amount = 1;

            try
            {
                if(settings.jokeCaching.jokePoolMinAmount < settings.jokes.maxAmount)
                    throw new Error(`Internal Error: min pool joke amount can't be smaller than max value of ?amount parameter`);

                const jokePoolSize = this.getJokePoolSize(langCode);


                const cacheEntriesAmount = 0;
                const cacheThreshold = 0;

                // TODO:
                if(cacheEntriesAmount > cacheThreshold)
                {
                    const insValuesGet = [
                        this.tableName,
                        clientIpHash,
                        langCode,
                        amount
                    ];

                    const rowsToDelete = await sendQuery(this.dbConnection, "SELECT * FROM ?? WHERE ClientIpHash = ? AND LangCode = ? ORDER BY `DateTime` ASC, JokeID ASC LIMIT ?;", ...insValuesGet);

                    /** @type {number[]} */
                    const idsToDelete = rowsToDelete.map(row => row["JokeID"]);

                    const sqlJokeIdList = mysql.format(`(${idsToDelete.join(", ")})`);


                    const insValuesDel = [
                        this.tableName,
                        clientIpHash,
                        langCode
                    ];

                    const deleteResult = await sendQuery(this.dbConnection, `DELETE FROM ?? WHERE ClientIpHash = ? AND LangCode = ? AND JokeID IN ${sqlJokeIdList};`, ...insValuesDel);


                    return res(deleteResult ? deleteResult.affectedRows : 0);
                }
                else
                    return res(0);
            }
            catch(err)
            {
                return rej(`Error while clearing old joke cache entries: ${err}`);
            }
        });
    }

    /**
     * Queries the DB for a list of all joke IDs the client has in their joke cache.
     * @param {string} clientIpHash 64-character IP hash of the client
     * @param {string} langCode Language code of the joke to cache
     * @returns {Promise<number[], string>} An array of joke IDs
     */
    listEntries(clientIpHash, langCode)
    {
        return new Promise((pRes, pRej) => {
            if(!this.allowCaching(langCode))
                return pRes([]);

            if(!isValidIpHash(clientIpHash))
                throw new TypeError(`Parameter "clientIpHash" is not a string or not a valid IP hash`);

            if(!isValidLang(langCode))
                throw new TypeError(`Parameter "langCode" is not a valid language code`);

            const insValues = [
                this.tableName,
                clientIpHash,
                langCode
            ];

            sendQuery(this.dbConnection, `SELECT JokeID FROM ?? WHERE ClientIpHash = ? AND LangCode = ?;`, ...insValues)
                .then(res => {
                    res = res.map(itm => itm.JokeID).sort();

                    return pRes(res);
                }).catch(err => {
                    return pRej(err);
                });
        });
    }

    /**
     * Runs the joke cache garbage collector
     */
    runGC()
    {
        debug("JokeCache/GC", `Running joke cache garbage collector...`);

        return new Promise(async (res, rej) => {
            /** Amount of entries that were cleared from the joke cache */
            let clearedEntries = 0;

            const startTS = Date.now();

            try
            {
                if(!this.dbConnection)
                    throw new Error(`Error while running garbage collector, DB connection isn't established yet`);

                const expiredEntries = await sendQuery(this.dbConnection, "SELECT * FROM ?? WHERE DATE_ADD(`DateTime`, INTERVAL ? HOUR) < CURRENT_TIMESTAMP;", this.tableName, settings.jokeCaching.expiryHours);

                /** @type {(() => Promise<any>)[]} */
                const deletePromises = [];

                expiredEntries.forEach(entry => {
                    const { ClientIpHash, JokeID, LangCode } = entry;

                    deletePromises.push(() => new Promise(async (delRes, delRej) => {
                        try
                        {
                            const result = await sendQuery(this.dbConnection, "DELETE FROM ?? WHERE ClientIpHash = ? AND JokeID = ? AND LangCode = ?;", this.tableName, ClientIpHash, JokeID, LangCode);

                            if(result.affectedRows > 0)
                                clearedEntries += result.affectedRows;

                            return delRes();
                        }
                        catch(err)
                        {
                            return delRej(err);
                        }
                    }));
                });


                await promiseAllSequential(deletePromises);
            }
            catch(err)
            {
                return rej(err);
            }

            debug("JokeCache/GC", `Cleared ${clearedEntries > 0 ? `${col.green}` : ""}${clearedEntries}${col.rst} entr${clearedEntries === 1 ? "y" : "ies"} in ${Date.now() - startTS}ms`, "green");
            return res();
        });
    }
}

module.exports = JokeCache;
