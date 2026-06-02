<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage, type UploadRawFile } from 'element-plus';
import { importQualifications, type OrgSource, type ImportSummary } from '@/api/watchlist';

const visible = defineModel<boolean>('visible', { default: false });
const emit = defineEmits<{ imported: [] }>();

const source = ref<OrgSource>('cnas');
const file = ref<File | null>(null);
const importing = ref(false);
const lastSummary = ref<ImportSummary | null>(null);

const sourceOptions: Array<{ value: OrgSource; label: string }> = [
  { value: 'prov_cma', label: '省级 CMA' },
  { value: 'cnas', label: 'CNAS' },
  { value: 'nat_cma', label: '国家 CMA' },
];

function onFileChange(uploadFile: { raw?: UploadRawFile }) {
  file.value = uploadFile.raw ?? null;
}

async function doImport() {
  if (!file.value) { ElMessage.warning('请先选择 Excel 文件'); return; }
  importing.value = true;
  try {
    const { summary } = await importQualifications(source.value, file.value);
    lastSummary.value = summary;
    ElMessage.success(`导入完成：成功 ${summary.inserted} 条，跳过 ${summary.skipped} 条`);
    emit('imported');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '导入失败');
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="导入本机构资质明细" width="520px">
    <el-form label-width="92px">
      <el-form-item label="资质类别">
        <el-radio-group v-model="source">
          <el-radio-button v-for="o in sourceOptions" :key="o.value" :value="o.value">{{ o.label }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="Excel 文件">
        <el-upload
          :auto-upload="false"
          :limit="1"
          accept=".xlsx,.xls"
          :on-change="onFileChange"
          :on-exceed="() => ElMessage.warning('一次只能选一个文件')"
        >
          <el-button>选择文件</el-button>
          <template #tip>
            <div class="upload-tip">表头需含「标准号」列；可含 标准名称 / 检测项目 / 类别 等列。重复导入会覆盖本机构该类旧明细。</div>
          </template>
        </el-upload>
      </el-form-item>
      <el-alert
        v-if="lastSummary && lastSummary.skippedReasons.length"
        type="warning" :closable="false" show-icon
        :title="`跳过 ${lastSummary.skipped} 行`"
      >
        <div v-for="(r, i) in lastSummary.skippedReasons" :key="i" class="skip-reason">{{ r }}</div>
      </el-alert>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button type="primary" :loading="importing" @click="doImport">导入</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.upload-tip { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
.skip-reason { font-size: 12px; }
</style>
