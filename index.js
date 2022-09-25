const path = require("path"),
  fs = require("fs"),
  { google } = require("googleapis");

const listMessages = async ({ googleAuth, pageToken, query }) => {
  const gmail = google.gmail({
    userId: "me",
    maxResults: 300,
    version: "v1",
    auth: googleAuth,
  });

  const options = { userId: "me" };
  if (pageToken) {
    options.pageToken = pageToken;
  }
  if (query) {
    options.q = query;
  }
  const rawMessages = await gmail.users.messages.list(options);
  const { messages, nextPageToken } = rawMessages.data;
  return { nextPageToken, messages: messages };
};

const getMessage = async ({ googleAuth, messageId }) => {
  const gmail = google.gmail({
    userId: "me",
    version: "v1",
    auth: googleAuth,
  });

  const options = { userId: "me", id: messageId };
  const m = await gmail.users.messages.get(options);
  return m;
};

const getGoogleAuth = async () => {
  const { client_id, client_secret, redirect_uris } = JSON.parse(
    fs.readFileSync("credentials.json", "utf-8")
  ).installed;
  const googleAuth = new google.auth.OAuth2({
    clientId: client_id,
    clientSecret: client_secret,
    redirectUri: redirect_uris[redirect_uris.length - 1],
  });
  const token = JSON.parse(await fs.readFileSync("token.json", "utf-8"));
  googleAuth.setCredentials(token);
  return googleAuth;
};

// if there are no records yet, it will page through "gmail.users.messages.list" requests to get everything
// otherwise, it will use "gmail.users.history.list" (which gives the adds/deletes/changes)
const synchronizeMessages = async (job, done) => {
  try {
    const {
      sourceLabel,
      ignoredLabels,
      ignoreMessageLabels,
      authProviderStateId,
      tagPrefix,
    } = job.attrs.data;
    const googleAuth = await getGoogleAuth(authProviderStateId);

    const startHistoryId = await elasticApi.getMaxHistoryId(sourceLabel);

    const messagesMethod = startHistoryId
      ? incrementalDiffMessages
      : listMessages;

    await agendaJobLogHelper.logJobStart(job);
    let totalProcessed = 0;
    let nextPageToken = null;
    let messagesToAdd, messagesToDelete;
    do {
      let messageMethodResponse = await messagesMethod(
        googleAuth,
        nextPageToken,
        startHistoryId
      );

      nextPageToken = messageMethodResponse.nextPageToken;
      messagesToAdd = messageMethodResponse.messagesToAdd;
      messagesToDelete = messageMethodResponse.messagesToDelete;

      if (messagesToDelete && messagesToDelete.length > 0) {
        const messageIds = _.map(messagesToDelete, "id");
        const messageIdsWithSource = _.map(messageIds, (miid) => {
          return `${sourceLabel}_${miid}`;
        });
        await elasticApi.deleteIds(messageIdsWithSource);
      }

      for (let m of messagesToAdd) {
        let msg;
        try {
          msg = await googleHelper.getGmailMessage(googleAuth, m.id);
        } catch (e) {
          if (e.code === 404) {
            continue;
          }
          throw e;
        }
        let messageDate = new Date(0);
        const ignoredLabelsLC = _.map(ignoredLabels, (t) => t.toLowerCase());
        messageDate.setUTCSeconds(msg.internalDate / 1000);
        const includedTags = _.map(
          _.filter(
            msg.labelIds,
            (l) => !ignoredLabelsLC.includes(l.toLowerCase())
          ),
          (t) => `${tagPrefix || ""}${t}`
        );
        const ignoredTags = _.map(
          _.filter(msg.labelIds, (l) =>
            ignoredLabelsLC.includes(l.toLowerCase())
          ),
          (t) => `${tagPrefix || ""}${t}`
        );

        const labelsLC = _.map(msg.labelIds, (t) => t.toLowerCase());
        const ignoreThisMessage =
          _.filter(ignoreMessageLabels, (imt) =>
            labelsLC.includes(imt.toLowerCase())
          ).length > 0;

        const textHtml = msg.textHtml || msg.textPlain || "";
        let attachments = [];
        try {
          attachments = await prepareAttachments(msg);
        } catch (err) {
          await agendaJobLogHelper.logJobError(job, err);
        }
        const elasticMessage = {
          created: messageDate,
          modified: messageDate,
          length: textHtml.length,
          name: msg.headers.subject,
          from: msg.headers.from,
          historyId: parseInt(msg.historyId),
          to: msg.headers.to,
          body: textHtml,
          threadId: msg.threadId,
          id: `${sourceLabel}_${msg.id}`,
          tags: includedTags,
          ignoredTags,
          ignored: ignoreThisMessage,
          attachments: attachments,
          ubqtSource: sourceLabel,
        };
        await elasticApi.createUpdateDocument(elasticMessage);
      }
      totalProcessed += messagesToAdd.length;
    } while (nextPageToken);

    await agendaJobLogHelper.logJobSuccess(job, { totalProcessed });
    done();
  } catch (error) {
    done(error);
  }
};

(async () => {
  const googleAuth = await getGoogleAuth();
  let pageToken = undefined;
  let allMessages = [];
  while (pageToken !== null) {
    const res = await listMessages({
      googleAuth,
      query: `in:sent subject:"Torrent complete"`,
      pageToken,
    });
    pageToken = res.nextPageToken;
    if (!pageToken) {
      pageToken = null;
    }
    allMessages = [...allMessages, ...res.messages];
  }
  const uniqueShowNames = [];
  for (const a of allMessages) {
    const m = await getMessage({ googleAuth, messageId: a.id });
    const subjectHeader = m.data.payload.headers.filter(
      (h) => h.name.toLowerCase() === "subject"
    )[0];

    // trim off the "torrent complete:" and "SxxExx"
    let trimmed = subjectHeader.value.slice(17).trim();
    const parts = trimmed.split(" ");
    const lastWordLength = parts[parts.length - 1].length;
    trimmed = trimmed.slice(0, trimmed.length - lastWordLength).trim();
    if (!uniqueShowNames.includes(trimmed)) {
      uniqueShowNames.push(trimmed);
    }
  }
  uniqueShowNames.sort();
  for (const s of uniqueShowNames) {
    console.log(s);
  }
})();
