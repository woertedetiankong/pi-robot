import { Type } from 'typebox';
import { DocumentService, type Scope, type Result } from './service.ts';

const id = Type.String({description:'Document ID returned by document_import or /docs add'});
const page = Type.Integer({minimum:1});
const optId = { documentId:Type.Optional(id) };
export const definitions = [
  { name:'document_import', description:'Import a local PDF, image, text or Markdown file in this workspace into the session scope. Cached by content and parser version. Default PDF coverage: first 30 pages. Use explicit ranges for large manuals. Outside-workspace files require user /docs add.',
    parameters:Type.Object({path:Type.String(),pages:Type.Optional(Type.String({description:'1-based physical PDF pages, e.g. 1-5,20-25; at most 100 per import'}))}) },
  { name:'document_list',description:'List only the current session document scope and parse coverage.',parameters:Type.Object({}) },
  { name:'document_grep',description:'Literal case-insensitive lookup of exact pins, register names, addresses or units in scoped text and completed OCR. Returns source labels and nearby text.',
    parameters:Type.Object({...optId,query:Type.String(),limit:Type.Optional(Type.Integer({minimum:1,maximum:30}))}) },
  { name:'document_search',description:'Rank scoped pages by lexical query terms when the identifier is unknown. Not semantic embeddings; use synonyms if needed. OCR image text first when necessary.',
    parameters:Type.Object({...optId,query:Type.String(),limit:Type.Optional(Type.Integer({minimum:1,maximum:30}))}) },
  { name:'document_read',description:'Read a physical page in imported coverage, with native/OCR text and citations. Paginate long pages using offset and limit.',
    parameters:Type.Object({...optId,pageNumber:page,offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:20000}))}) },
  { name:'document_view_page',description:'Return a page overview as an actual image to the model, plus pixel dimensions and citation. Inspect this for schematic, timing, pinout or layout questions.',
    parameters:Type.Object({...optId,pageNumber:page}) },
  { name:'document_create_crop',description:'Return a semantic region as an actual image. Coordinates are pixels of document_view_page; include the whole functional block and labels.',
    parameters:Type.Object({...optId,pageNumber:page,label:Type.String(),bbox:Type.Object({x:Type.Integer({minimum:0}),y:Type.Integer({minimum:0}),width:Type.Integer({minimum:16}),height:Type.Integer({minimum:16})})}) },
  { name:'document_view_region',description:'Return an existing crop image by its cropId. Does not interpret its contents.',parameters:Type.Object({...optId,cropId:Type.String()}) },
  { name:'document_ocr',description:'Force local Tesseract OCR on a page or existing crop, including mixed pages with native text. Results are cached and searchable. First use downloads language model files unless PI_EMBEDDED_DOCS_TESSDATA is configured; document bytes stay local. OCR is not circuit interpretation.',
    parameters:Type.Object({...optId,pageNumber:page,cropId:Type.Optional(Type.String()),language:Type.Optional(Type.String({description:'Default eng; e.g. eng+chi_sim for English and simplified Chinese'}))}) },
  { name:'document_check_citations',description:'Check source labels against current scope, page coverage and saved evidence. Checks existence only, not truth of the associated claim.',parameters:Type.Object({citations:Type.Array(Type.String(),{maxItems:50})}) },
];
export const toolNames = definitions.map(d=>d.name);

export function chooseDocument(scope: Scope, requested?: string) {
  if (requested) return requested;
  if (scope.ids.length !== 1) throw new Error('Specify documentId when zero or multiple documents are selected');
  return scope.ids[0];
}
export async function dispatch(service:DocumentService,scope:Scope,name:string,args:any,signal?:AbortSignal):Promise<Result> {
  signal?.throwIfAborted();
  if (name==='document_import') {
    const doc=await service.importFile(args.path,args.pages,false,signal);
    if (!scope.ids.includes(doc.id)) scope.ids.push(doc.id);
    return {data:service.summary(doc)};
  }
  if (name==='document_list') return {data:await service.list(scope)};
  if (name==='document_check_citations') return {data:await service.check(args.citations,scope)};
  if (name==='document_grep'||name==='document_search') return {data:await service.search(args.query,scope,args.documentId,name==='document_grep',args.limit)};
  const id=chooseDocument(scope,args.documentId);
  switch(name) {
    case 'document_read':return {data:await service.read(id,args.pageNumber,scope,args.offset,args.limit)};
    case 'document_view_page':return service.view(id,args.pageNumber,scope,signal);
    case 'document_create_crop':return service.crop(id,args.pageNumber,args.bbox,args.label,scope,signal);
    case 'document_view_region':return service.region(id,args.cropId,scope);
    case 'document_ocr':return {data:await service.ocr(id,args.pageNumber,scope,args.language,args.cropId,signal)};
    default:throw new Error('Unknown document tool');
  }
}
