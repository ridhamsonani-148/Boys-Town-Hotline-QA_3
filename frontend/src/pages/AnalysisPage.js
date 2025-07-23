import AnalysisContainer from '../components/analysis';

function AnalysisPage({ fileName, onBackToUpload }) {
  return (
    <div>
      <AnalysisContainer fileName={fileName} onBackToUpload={onBackToUpload} />
    </div>
  );
}

export default AnalysisPage;