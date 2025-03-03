const AWS = require("aws-sdk");
const {
  dynamodb,
  runQuery,
  TABLE_NAME,
  getOne,
  FISCAL_YEAR_FINAL_MONTH,
  TIMEZONE,
} = require("../../dynamoUtil");
const { sendResponse } = require("../../responseUtil");
const { decodeJWT, resolvePermissions } = require("../../permissionUtil");
const { logger } = require("../../logger");
const { DateTime } = require("luxon");

exports.handlePost = async (event, context) => {
  logger.debug("Activity POST:", event);
  return await main(event, context);
};

exports.handleLock = async (event, context) => {
  logger.debug("Record Lock POST:", event);
  return await main(event, context, true);
};

exports.handleUnlock = async (event, context) => {
  logger.debug("Record Unlock POST:", event);
  return await main(event, context, false);
};

async function main(event, context, lock = null) {
  try {
    const token = await decodeJWT(event);
    const permissionObject = resolvePermissions(token);

    if (!permissionObject.isAuthenticated) {
      logger.info("**NOT AUTHENTICATED, PUBLIC**");
      return sendResponse(403, { msg: "Error: UnAuthenticated." }, context);
    }

    const body = JSON.parse(event.body);

    if (
      !permissionObject.isAdmin &&
      permissionObject.roles.includes(`${body.orcs}:${body.subAreaId}`) ===
        false
    ) {
      logger.info("Not authorized.");
      logger.debug(permissionObject.roles);
      return sendResponse(403, { msg: "Unauthorized." }, context);
    }

    if (await verifyBody(body)) {
      logger.info("Fiscal year is locked.");
      logger.debug("verifyBody", body);
      return sendResponse(400, { msg: "Invalid request." });
    }

    // check if fiscal year is locked
    if (await checkFiscalYearLock(body)) {
      logger.debug("checkFiscalYearLock", body);
      return sendResponse(
        403,
        {
          msg: `This fiscal year has been locked against editing by the system administrator.`,
        },
        context
      );
    }

    // Disabling the ability to change config for now.
    // Request used to necessitate 'type = activity/config' as a queryParam (was future proofing).
    // Queryparams no longer required. All info included in request body.
    // Refer to code prior to 2022-09-27 for handleConfig.

    // check if attempting to lock current/future month
    // Not allowed as per https://bcparksdigital.atlassian.net/browse/BRS-817
    if (lock && (await checkLockingDates(body))) {
      logger.debug("checkLockingDates", body);
      return sendResponse(
        403,
        { msg: "Cannot lock a record for a month that has not yet concluded." },
        context
      );
    }

    // check if record is locked
    const unlocking = lock === false ? true : false;
    const existingRecord = await getOne(
      `${body.subAreaId}::${body.activity}`,
      body.date
    );
    if (existingRecord?.isLocked && !unlocking) {
      logger.info("Record is locked.");
      logger.debug("locking", existingRecord?.isLocked, !unlocking);
      return sendResponse(409, { msg: "Record is locked." });
    }

    // handle locking/unlocking existing records
    if (lock !== null) {
      if (existingRecord?.pk) {
        return await handleLockUnlock(existingRecord, lock, context);
      } else if (lock === false) {
        // if record doesnt exist, we can't unlock it
        logger.info("Record not found.");
        return sendResponse(404, { msg: "Record not found." });
      }
      // if we are locking a record that doesn't exist, we need to create it.
      // fall through and create new record for locking.
      lock = true;
    }
    return await handleActivity(body, lock, context);
  } catch (err) {
    logger.error(err);
    return sendResponse(400, { msg: "Invalid request" }, context);
  }
}

async function checkFiscalYearLock(body) {
  // extract fiscal year from date
  let recordYear = Number(body.date.slice(0, 4));
  let recordMonth = Number(body.date.slice(4, 6));
  if (recordMonth > FISCAL_YEAR_FINAL_MONTH) {
    recordYear++;
  }
  const fiscalYearEndObj = await getOne("fiscalYearEnd", String(recordYear));
  if (fiscalYearEndObj?.isLocked) {
    return true;
  }
  return false;
}

async function checkLockingDates(body) {
  const beginningOfMonth = DateTime.now().setZone(TIMEZONE).startOf("month");
  const recordDate = DateTime.fromObject(
    {
      year: Number(body.date.slice(0, 4)),
      month: Number(body.date.slice(4, 6)),
    },
    {
      zone: TIMEZONE,
    }
  );
  if (recordDate >= beginningOfMonth) {
    return true;
  }
  return false;
}

async function verifyBody(body) {
  if (!body.subAreaId || !body.activity || !body.date) {
    return true;
  }
  // delete isLocked - need correct path to lock/unlock records
  delete body.isLocked;
  return false;
}

async function handleLockUnlock(record, lock, context) {
  const updateObj = {
    TableName: TABLE_NAME,
    Key: {
      pk: { S: record.pk },
      sk: { S: record.sk },
    },
    UpdateExpression: "set isLocked = :isLocked",
    ConditionExpression: "isLocked <> :isLocked",
    ExpressionAttributeValues: {
      ":isLocked": { BOOL: lock },
    },
    ReturnValues: "ALL_NEW",
  };
  try {
    const res = await dynamodb.updateItem(updateObj).promise();
    logger.info(`Updated record pk: ${record.pk}, sk: ${record.sk} `);
    const s = lock ? "locked" : "unlocked";
    return sendResponse(200, {
      msg: `Record successfully ${s}`,
      data: AWS.DynamoDB.Converter.unmarshall(res.Attributes),
    });
  } catch (err) {
    if (err.code === "ConditionalCheckFailedException") {
      return sendResponse(409, {
        msg: "Record is already locked/unlocked",
        error: err,
      });
    }
    return sendResponse(400, {
      msg: "Record lock/unlock failed: ",
      error: err,
    });
  }
}

async function handleActivity(body, lock = false, context) {
  // Set pk/sk
  try {
    const pk = `${body.subAreaId}::${body.activity}`;

    // Get config to attach to activity
    const configObj = {
      TableName: TABLE_NAME,
      ExpressionAttributeValues: {
        ":pk": { S: `config::${body.subAreaId}` },
        ":sk": { S: body.activity },
      },
      KeyConditionExpression: "pk =:pk AND sk =:sk",
    };
    const configData = (await runQuery(configObj))[0];
    if (!configData?.orcs || !configData?.parkName) {
      throw "Malformed config object";
    }
    body["config"] = configData;
    body["orcs"] = body["orcs"] ? body["orcs"] : configData.orcs;
    body["parkName"] = body["parkName"]
      ? body["parkName"]
      : configData.parkName;
    body["subAreaName"] = body["subAreaName"]
      ? body["subAreaName"]
      : configData.subAreaName;

    body["pk"] = pk;

    if (body.date.length !== 6 || isNaN(body.date)) {
      throw "Invalid date.";
    }

    body["sk"] = body.date;
    body["lastUpdated"] = new Date().toISOString();

    body["isLocked"] = lock ?? false;

    const newObject = AWS.DynamoDB.Converter.marshall(body);

    let putObject = {
      TableName: TABLE_NAME,
      Item: newObject,
    };

    await dynamodb.putItem(putObject).promise();
    logger.info("Activity Updated.");
    return sendResponse(200, body, context);
  } catch (err) {
    logger.error(err);
    return sendResponse(400, err, context);
  }
}
