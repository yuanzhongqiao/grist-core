/**
 * DocWorker collects the methods and endpoints that relate to a single Grist document.
 * In hosted environment, this comprises the functionality of the DocWorker instance type.
 */
import {HomeDBManager} from 'app/gen-server/lib/HomeDBManager';
import {ActionHistoryImpl} from 'app/server/lib/ActionHistoryImpl';
import {assertAccess, getOrSetDocAuth, getUserId, RequestWithLogin} from 'app/server/lib/Authorizer';
import {Client} from 'app/server/lib/Client';
import * as Comm from 'app/server/lib/Comm';
import {DocSession, docSessionFromRequest} from 'app/server/lib/DocSession';
import {filterDocumentInPlace} from 'app/server/lib/filterUtils';
import {IDocStorageManager} from 'app/server/lib/IDocStorageManager';
import * as log from 'app/server/lib/log';
import {integerParam, optStringParam, stringParam} from 'app/server/lib/requestUtils';
import {OpenMode, quoteIdent, SQLiteDB} from 'app/server/lib/SQLiteDB';
import {generateCSV, generateXLSX} from 'app/server/serverMethods';
import * as contentDisposition from 'content-disposition';
import * as express from 'express';
import * as fse from 'fs-extra';
import * as mimeTypes from 'mime-types';
import * as path from 'path';

export interface AttachOptions {
  comm: Comm;                             // Comm object for methods called via websocket
}

export class DocWorker {
  private _comm: Comm;
  constructor(private _dbManager: HomeDBManager, {comm}: AttachOptions) {
    this._comm = comm;
  }

  public async getCSV(req: express.Request, res: express.Response): Promise<void> {
    await generateCSV(req, res, this._comm);
  }

  public async getXLSX(req: express.Request, res: express.Response): Promise<void> {
    await generateXLSX(req, res, this._comm);
  }

  public async getAttachment(req: express.Request, res: express.Response): Promise<void> {
    try {
      const docSession = this._getDocSession(stringParam(req.query.clientId),
                                             integerParam(req.query.docFD));
      const activeDoc = docSession.activeDoc;
      const ext = path.extname(stringParam(req.query.ident));
      const type = mimeTypes.lookup(ext);

      let inline = Boolean(req.query.inline);
      // Serving up user-uploaded HTML files inline is an open door to XSS attacks.
      if (type === "text/html") { inline = false; }

      // Construct a content-disposition header of the form 'inline|attachment; filename="NAME"'
      const contentDispType = inline ? "inline" : "attachment";
      const contentDispHeader = contentDisposition(stringParam(req.query.name), {type: contentDispType});
      const data = await activeDoc.getAttachmentData(docSession, stringParam(req.query.ident));
      res.status(200)
        .type(ext)
        .set('Content-Disposition', contentDispHeader)
        .set('Cache-Control', 'private, max-age=3600')
        .send(data);
    } catch (err) {
      res.status(404).send({error: err.toString()});
    }
  }

  public async downloadDoc(req: express.Request, res: express.Response,
                           storageManager: IDocStorageManager): Promise<void> {
    const mreq = req as RequestWithLogin;
    if (!mreq.docAuth || !mreq.docAuth.docId) { throw new Error('Cannot find document'); }
    const docId = mreq.docAuth.docId;

    // Query DB for doc metadata to get the doc title.
    const doc = await this._dbManager.getDoc({userId: getUserId(req), org: mreq.org, urlId: docId});
    const docTitle = doc.name;

    // Get a copy of document for downloading.
    const tmpPath = await storageManager.getCopy(docId);
    if (req.query.template === '1') {
      // If template flag is on, remove data and history from the download.
      await removeData(tmpPath);
    }
    await filterDocumentInPlace(docSessionFromRequest(mreq), tmpPath);
    // NOTE: We may want to reconsider the mimeType used for Grist files.
    return res.type('application/x-sqlite3')
      .download(tmpPath, (optStringParam(req.query.title) || docTitle || 'document') + ".grist", async (err: any) => {
        if (err) {
          log.error(`Download failure for doc ${docId}`, err);
        }
        await fse.unlink(tmpPath);
      });
  }

  // Register main methods related to documents.
  public registerCommCore(): void {
    const comm = this._comm;
    comm.registerMethods({
      closeDoc:                 activeDocMethod.bind(null, null, 'closeDoc'),
      fetchTable:               activeDocMethod.bind(null, 'viewers', 'fetchTable'),
      fetchTableSchema:         activeDocMethod.bind(null, 'viewers', 'fetchTableSchema'),
      useQuerySet:              activeDocMethod.bind(null, 'viewers', 'useQuerySet'),
      disposeQuerySet:          activeDocMethod.bind(null, 'viewers', 'disposeQuerySet'),
      applyUserActions:         activeDocMethod.bind(null, 'editors', 'applyUserActions'),
      applyUserActionsById:     activeDocMethod.bind(null, 'editors', 'applyUserActionsById'),
      findColFromValues:        activeDocMethod.bind(null, 'viewers', 'findColFromValues'),
      getFormulaError:          activeDocMethod.bind(null, 'viewers', 'getFormulaError'),
      importFiles:              activeDocMethod.bind(null, 'editors', 'importFiles'),
      finishImportFiles:        activeDocMethod.bind(null, 'editors', 'finishImportFiles'),
      cancelImportFiles:        activeDocMethod.bind(null, 'editors', 'cancelImportFiles'),
      addAttachments:           activeDocMethod.bind(null, 'editors', 'addAttachments'),
      removeInstanceFromDoc:    activeDocMethod.bind(null, 'editors', 'removeInstanceFromDoc'),
      startBundleUserActions:   activeDocMethod.bind(null, 'editors', 'startBundleUserActions'),
      stopBundleUserActions:    activeDocMethod.bind(null, 'editors', 'stopBundleUserActions'),
      autocomplete:             activeDocMethod.bind(null, 'viewers', 'autocomplete'),
      fetchURL:                 activeDocMethod.bind(null, 'viewers', 'fetchURL'),
      getActionSummaries:       activeDocMethod.bind(null, 'viewers', 'getActionSummaries'),
      reloadDoc:                activeDocMethod.bind(null, 'editors', 'reloadDoc'),
      fork:                     activeDocMethod.bind(null, 'viewers', 'fork'),
      checkAclFormula:          activeDocMethod.bind(null, 'viewers', 'checkAclFormula'),
      getAclResources:          activeDocMethod.bind(null, 'viewers', 'getAclResources'),
    });
  }

  // Register methods related to plugins.
  public registerCommPlugin(): void {
    this._comm.registerMethods({
      forwardPluginRpc:         activeDocMethod.bind(null, 'editors', 'forwardPluginRpc'),
      // TODO: consider not providing reloadPlugins on hosted grist, since it affects the
      // plugin manager shared across docs on a given doc worker, and seems useful only in
      // standalone case.
      reloadPlugins:            activeDocMethod.bind(null, 'editors', 'reloadPlugins'),
    });
  }

  // Checks that document is accessible, and adds docAuth information to request.
  // Otherwise issues a 403 access denied.
  // (This is used for endpoints like /download, /gen-csv, /attachment.)
  public async assertDocAccess(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) {
    const mreq = req as RequestWithLogin;
    let urlId: string|undefined;
    try {
      if (optStringParam(req.query.clientId)) {
        const activeDoc = this._getDocSession(stringParam(req.query.clientId),
                                              integerParam(req.query.docFD)).activeDoc;
        // TODO: The docId should be stored in the ActiveDoc class. Currently docName is
        // used instead, which will coincide with the docId for hosted grist but not for
        // standalone grist.
        urlId = activeDoc.docName;
      } else {
        // Otherwise, if being used without a client, expect the doc query parameter to
        // be the docId.
        urlId = stringParam(req.query.doc);
      }
      if (!urlId) { return res.status(403).send({error: 'missing document id'}); }

      const docAuth = await getOrSetDocAuth(mreq, this._dbManager, urlId);
      assertAccess('viewers', docAuth);
      next();
    } catch (err) {
      log.info(`DocWorker can't access document ${urlId} with userId ${mreq.userId}: ${err}`);
      res.status(err.status || 404).send({error: err.toString()});
    }
  }

  private _getDocSession(clientId: string, docFD: number): DocSession {
    const client = this._comm.getClient(clientId);
    return client.getDocSession(docFD);
  }
}

/**
 * Translates calls from the browser client into calls of the form
 * `activeDoc.method(docSession, ...args)`.
 */
async function activeDocMethod(role: 'viewers'|'editors'|null, methodName: string, client: Client,
                               docFD: number, ...args: any[]): Promise<any> {
  const docSession = client.getDocSession(docFD);
  const activeDoc = docSession.activeDoc;
  if (role) { await docSession.authorizer.assertAccess(role); }
  // Include a basic log record for each ActiveDoc method call.
  log.rawDebug('activeDocMethod', activeDoc.getLogMeta(docSession, methodName));
  return (activeDoc as any)[methodName](docSession, ...args);
}

/**
 * Remove rows from all user tables, and wipe as much history as we can.
 */
async function removeData(filename: string) {
  const db = await SQLiteDB.openDBRaw(filename, OpenMode.OPEN_EXISTING);
  const tableIds = (await db.all("SELECT name FROM sqlite_master WHERE type='table'"))
    .map(row => row.name as string)
    .filter(name => !name.startsWith('_grist'));
  for (const tableId of tableIds) {
    await db.run(`DELETE FROM ${quoteIdent(tableId)}`);
  }
  const history = new ActionHistoryImpl(db);
  await history.deleteActions(1);
  await db.run('VACUUM');
  await db.close();
}
