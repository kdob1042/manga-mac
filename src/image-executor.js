// Inject only the registry resolver and native transport. Production and fixtures use the same gate.
export function createImageExecutor(resolve, invoke) {
 return async function execute(modelId, request, permit=null) {
  const selected=resolve(modelId??request.media?.registry_id);
  const media={registry_id:selected.id,adapter_id:selected.adapter_id,model_id:selected.model_id};
  if(request.media&&Object.entries(media).some(([key,value])=>request.media[key]!==value))throw Error('画像要求と選択中のモデルが一致しません');
  return invoke('generate_image',{request:{...request,media}},permit);
 };
}
