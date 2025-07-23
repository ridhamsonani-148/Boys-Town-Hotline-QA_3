import { useState } from 'react';
import UploadContainer from '../components/upload';
import AnalysisPage from './AnalysisPage';

function UploadPage() {
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState('');

  const handleUploadSuccess = (fileName) => {
    setUploadedFileName(fileName);
    setShowAnalysis(true);
  };

  const handleBackToUpload = () => {
    setShowAnalysis(false);
    setUploadedFileName('');
  };

  if (showAnalysis) {
    return <AnalysisPage fileName={uploadedFileName} onBackToUpload={handleBackToUpload} />;
  }

  return (
    <div>
      <UploadContainer onUploadSuccess={handleUploadSuccess} />
    </div>
  );
}

export default UploadPage;